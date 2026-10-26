import { asc, count, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import type { Database } from "@/db/client";
import {
  insertAuditEvent,
  insertAuditEvents,
} from "@/db/repositories/audit.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { billingAccount } from "@/db/schema/billing/accounts";
import { STANDARD_TYPE_NAME } from "@/types/accounts";
import {
  RETIRE_AUDIT_CHUNK_SIZE,
  RETIRE_BAN_PAGE_SIZE,
  type BillTemplateFamily,
  type BoundBanRow,
  type RetireTemplateTypeResult,
  type TemplateTypeErrorCode,
  type TemplateTypeStatus,
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
      code: Extract<
        TemplateTypeErrorCode,
        "TEMPLATE_TYPE_NAME_TAKEN" | "TEMPLATE_TYPE_NAME_INVALID"
      >;
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

// bm82 (CM guardrail 11 exemption) — BANs bound per type; NULL counted under Standard.
// Every state, matching what a retire (bm83) must move. Standard is reached through
// `is_default`, never an id literal (General rule 8).
export async function countBoundBansByType(
  db: Database,
): Promise<Map<string, number>> {
  const rows = await db.execute<{ type_id: string | null; n: number }>(sql`
    SELECT COALESCE(ba.ref_bill_template_family_id, dft.bill_template_family_id) AS type_id,
           count(*)::int AS n
    FROM billing.billing_account ba
    LEFT JOIN (
      SELECT bill_template_family_id FROM billing.bill_template_family WHERE is_default
    ) dft ON true
    GROUP BY 1`);
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.type_id !== null) counts.set(r.type_id, r.n);
  }
  return counts;
}

type RetireFailureCode = Extract<
  RetireTemplateTypeResult,
  { ok: false }
>["code"];

// Thrown inside the transaction to roll it back, then mapped to a result
// outside (a returned value would COMMIT) — the ActivationRollback pattern.
class RetireRollback extends Error {
  constructor(readonly code: RetireFailureCode) {
    super(code);
  }
}

// bm83 (Inv #66, #67) — retire a type and move every BAN bound to it to one usable target,
// in ONE transaction. The only Billing writer of billing_account.ref_bill_template_family_id
// (CM guardrail 11; billing guardrail 79). Never touches bill_template_version.
//
//   1. lock both type rows in ascending id order (General rule 7): the retired
//      type FOR UPDATE, a non-NULL target FOR SHARE; Standard (NULL) takes none
//   2. re-check under the locks → VALIDATION_ERROR, DEFAULT_TYPE_NOT_RETIRABLE,
//      TEMPLATE_TYPE_RETIRED, RETIRE_NAME_MISMATCH, RETIRE_TARGET_NOT_USABLE
//   3. one set-based switch of every bound BAN, every state (Standard → NULL,
//      General rule 8), bumping last_modified so an open BAN panel gets CONFLICT
//   4. one BILLING_ACCOUNT_TEMPLATE_CHANGED per moved BAN, in chunks of 500
//   5. zero BANs left on the type, or the whole transaction rolls back
//   6. retireType (the one update the type guard allows)
//   7. one INVOICE_TEMPLATE_TYPE_RETIRED
export async function retireTemplateType(
  input: { typeId: string; targetTypeId: string | null; confirmName: string },
  actorId: string,
): Promise<RetireTemplateTypeResult> {
  const { typeId, targetTypeId } = input;
  try {
    return await db.transaction(
      async (tx): Promise<RetireTemplateTypeResult> => {
        // 1. Ascending id order, shared with the bind gate and every retire.
        const ids = [
          ...new Set(
            [typeId, targetTypeId].filter((id): id is string => id !== null),
          ),
        ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const locked = new Map<string, BillTemplateFamily | null>();
        for (const id of ids) {
          locked.set(
            id,
            await billTemplateFamilyRepository.lockTemplateType(
              tx,
              id,
              id === typeId ? "update" : "share",
            ),
          );
        }

        // 2. The re-checks, in D3's order.
        const type = locked.get(typeId) ?? null;
        if (!type) throw new RetireRollback("VALIDATION_ERROR");
        if (type.isDefault) {
          throw new RetireRollback("DEFAULT_TYPE_NOT_RETIRABLE");
        }
        if (type.retiredDatetime !== null) {
          throw new RetireRollback("TEMPLATE_TYPE_RETIRED");
        }
        if (input.confirmName.trim() !== type.name) {
          throw new RetireRollback("RETIRE_NAME_MISMATCH");
        }
        const target =
          targetTypeId === null ? null : (locked.get(targetTypeId) ?? null);
        if (
          targetTypeId !== null &&
          (targetTypeId === typeId || !(await isUsable(tx, target)))
        ) {
          throw new RetireRollback("RETIRE_TARGET_NOT_USABLE");
        }
        const targetTypeName = target?.name ?? STANDARD_TYPE_NAME;

        // 3. The switch: one statement, closed BANs included.
        const moved = await tx
          .update(billingAccount)
          .set({
            refBillTemplateFamilyId: targetTypeId,
            lastModified: sql`now()`,
            lastEditedBy: actorId,
          })
          .where(eq(billingAccount.refBillTemplateFamilyId, typeId))
          .returning({ billingAccountId: billingAccount.billingAccountId });

        // 4. Each move audited as a bind is, plus the reason (CM Data rule 4).
        for (let i = 0; i < moved.length; i += RETIRE_AUDIT_CHUNK_SIZE) {
          await insertAuditEvents(
            tx,
            moved.slice(i, i + RETIRE_AUDIT_CHUNK_SIZE).map((ban) => ({
              eventType: "BILLING_ACCOUNT_TEMPLATE_CHANGED",
              actorUserId: actorId,
              targetEntity: "BILLING_ACCOUNT",
              targetId: ban.billingAccountId,
              beforeData: {
                refBillTemplateFamilyId: typeId,
                typeName: type.name,
              },
              afterData: {
                refBillTemplateFamilyId: targetTypeId,
                typeName: targetTypeName,
                reason: "TEMPLATE_TYPE_RETIRED",
              },
            })),
          );
        }

        // 5. Inv #66 — no BAN may be left on a retired type.
        const [remaining] = await tx
          .select({ n: count() })
          .from(billingAccount)
          .where(eq(billingAccount.refBillTemplateFamilyId, typeId));
        if ((remaining?.n ?? 0) > 0) throw new Error("RETIRE_BANS_REMAIN");

        // 6. One-way; the version rows are untouched (Inv #67).
        const retired = await billTemplateFamilyRepository.retireType(
          tx,
          typeId,
        );
        if (!retired) throw new RetireRollback("TEMPLATE_TYPE_RETIRED");

        // 7.
        await insertAuditEvent(tx, {
          eventType: "INVOICE_TEMPLATE_TYPE_RETIRED",
          actorUserId: actorId,
          targetEntity: "BILL_TEMPLATE_FAMILY",
          targetId: typeId,
          beforeData: {
            name: type.name,
            code: type.code,
            retiredDatetime: null,
          },
          afterData: {
            retiredDatetime: retired.retiredDatetime?.toISOString() ?? null,
            targetTypeId,
            targetTypeName,
            movedBanCount: moved.length,
          },
        });

        return { ok: true, movedBanCount: moved.length };
      },
    );
  } catch (error) {
    if (error instanceof RetireRollback) {
      return { ok: false, code: error.code };
    }
    throw error;
  }
}

// A retire target, read under its FOR SHARE lock: not Standard (which is NULL),
// not retired, with an ACTIVE settings version — what the bind gate accepts.
async function isUsable(
  tx: Database,
  target: BillTemplateFamily | null,
): Promise<boolean> {
  if (!target || target.isDefault || target.retiredDatetime !== null) {
    return false;
  }
  const active = await billTemplateVersionRepository.findActive(tx, {
    kind: "generated",
    familyId: target.billTemplateFamilyId,
  });
  return active !== null;
}

// bm83 (D8) — the BANs bound to a type, by billing_account_id, for the retire dialog.
export async function listBoundBans(
  db: Database,
  typeId: string,
  page: number,
): Promise<BoundBanRow[]> {
  return db
    .select({
      billingAccountId: billingAccount.billingAccountId,
      name: billingAccount.name,
      state: billingAccount.state,
    })
    .from(billingAccount)
    .where(eq(billingAccount.refBillTemplateFamilyId, typeId))
    .orderBy(asc(billingAccount.billingAccountId))
    .limit(RETIRE_BAN_PAGE_SIZE)
    .offset(page * RETIRE_BAN_PAGE_SIZE);
}
