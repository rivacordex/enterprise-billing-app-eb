import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import type {
  BillTemplateFamily,
  TemplateTypeErrorCode,
  TemplateTypeStatus,
} from "@/types/billing";
import { templateTypeNameSchema } from "@/validation/billing/template-type.schema";

// bm77-spec §Design / §5 (Inv #65) — invoice template types: name rules, the
// derived code and layout code, the derived status, and create type. A type
// starts EMPTY (no layout, no settings — "Not yet usable") until bm78 uploads
// a layout package. Type identity is never updated (General rule 9).

const CODE_MAX = 60; // btf_code_format: ^[A-Z][A-Z0-9_]{0,59}$
const MAX_ATTEMPTS = 5;
const UNIQUE_VIOLATION = "23505";

export const NAME_TAKEN_MESSAGE =
  "An invoice template type with this name already exists (names of retired types stay reserved).";

// Trim, and collapse internal whitespace runs to one space.
export function normalizeTemplateTypeName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

// Linear underscore trims (Sonar S5852: `/_+$/` backtracks on a long `_` run
// that does not end the string).
function trimTrailingUnderscores(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "_") end--;
  return s.slice(0, end);
}

function trimUnderscores(s: string): string {
  let start = 0;
  while (start < s.length && s[start] === "_") start++;
  return trimTrailingUnderscores(s.slice(start));
}

// Upper-case, each run of non-[A-Z0-9] → `_`, trim `_`, `T_` prefix when the
// result does not start with a letter, cut to 60 characters (btf_code_format).
// "Wholesale & Retail (East)" → WHOLESALE_RETAIL_EAST; "5G Enterprise" →
// T_5G_ENTERPRISE.
export function deriveTemplateTypeCode(name: string): string {
  let code = trimUnderscores(name.toUpperCase().replace(/[^A-Z0-9]+/g, "_"));
  if (!/^[A-Z]/.test(code)) code = `T_${code}`;
  return trimTrailingUnderscores(code.slice(0, CODE_MAX));
}

// The one place a type's status is derived (TS rule 4) — never stored.
export function deriveTemplateTypeStatus(
  type: Pick<BillTemplateFamily, "retiredDatetime">,
  hasActiveSettings: boolean,
): TemplateTypeStatus {
  if (type.retiredDatetime !== null) return "RETIRED";
  return hasActiveSettings ? "USABLE" : "NOT_YET_USABLE";
}

// `base`, then `base_2`, `base_3`… — each cut so it stays within 60 characters.
function candidateCode(base: string, n: number): string {
  if (n === 1) return base;
  const suffix = `_${n}`;
  return `${trimTrailingUnderscores(base.slice(0, CODE_MAX - suffix.length))}${suffix}`;
}

interface PgErrorFields {
  code?: string;
  constraint_name?: string;
}

// postgres.js puts SQLSTATE and the constraint on the error; drizzle may wrap
// it in `cause`.
function uniqueViolationConstraint(error: unknown): string | null {
  const e = error as (PgErrorFields & { cause?: PgErrorFields }) | undefined;
  const code = e?.code ?? e?.cause?.code;
  if (code !== UNIQUE_VIOLATION) return null;
  return e?.constraint_name ?? e?.cause?.constraint_name ?? null;
}

export type CreateTemplateTypeResult =
  | { ok: true; typeId: string; code: string; layoutCode: string }
  | {
      ok: false;
      code: TemplateTypeErrorCode;
      fieldErrors?: Record<string, string[]>;
    };

export async function createTemplateType(
  input: { name: string },
  actorId: string,
): Promise<CreateTemplateTypeResult> {
  const name = normalizeTemplateTypeName(input.name);
  const parsed = templateTypeNameSchema.safeParse(name);
  if (!parsed.success) {
    return {
      ok: false,
      code: "TEMPLATE_TYPE_NAME_INVALID",
      fieldErrors: { name: parsed.error.issues.map((i) => i.message) },
    };
  }
  const taken = {
    ok: false as const,
    code: "TEMPLATE_TYPE_NAME_TAKEN" as const,
    fieldErrors: { name: [NAME_TAKEN_MESSAGE] },
  };
  if (await billTemplateFamilyRepository.findByNameCi(db, name)) return taken;

  const base = deriveTemplateTypeCode(name);
  let n = 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    while (
      await billTemplateFamilyRepository.codeExists(db, candidateCode(base, n))
    ) {
      n++;
    }
    const code = candidateCode(base, n);
    const layoutCode = `INVTPL-${code}`;
    try {
      const created = await db.transaction(async (tx) => {
        const row = await billTemplateFamilyRepository.insertType(tx, {
          code,
          name,
          layoutCode,
          createdBy: actorId,
        });
        await insertAuditEvent(tx, {
          eventType: "INVOICE_TEMPLATE_TYPE_CREATED",
          actorUserId: actorId,
          targetEntity: "BILL_TEMPLATE_FAMILY",
          targetId: row.billTemplateFamilyId,
          beforeData: null,
          afterData: { name, code, layoutCode },
        });
        return row;
      });
      return {
        ok: true,
        typeId: created.billTemplateFamilyId,
        code,
        layoutCode,
      };
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint === "btf_name_ci_uq") return taken;
      if (constraint === "btf_code_uq" || constraint === "btf_layout_code_uq") {
        n++; // lost a race for this code: try the next suffix
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `createTemplateType: no free code for "${name}" after ${MAX_ATTEMPTS} attempts`,
  );
}
