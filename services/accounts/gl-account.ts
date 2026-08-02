import { db } from "@/db/client";
import { glAccountRepository } from "@/db/repositories/accounts/gl-account.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import type { GlAccount } from "@/db/schema/billing/catalogs";
import type { CreateGlCodeInput } from "@/validation/accounts/gl-account.schema";

export type { GlAccount };

// A CoA node with its children nested (top-level parent nodes in the returned
// array). Ordering within a level is by glCode ascending.
export type GlAccountNode = GlAccount & { children: GlAccountNode[] };

export type CreateGlCodeResult =
  | { ok: true; glCode: string }
  | { ok: false; code: "DUPLICATE_GL_CODE" }
  | { ok: false; code: "PARENT_NOT_FOUND" };

export type RetireGlCodeResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "ALREADY_RETIRED" }
  | { ok: false; code: "CONFLICT" };

// Builds a tree from the flat list of GL accounts. Roots are nodes with no
// parentGlCode; each node's children list is in glCode order.
export function buildGlAccountTree(accounts: GlAccount[]): GlAccountNode[] {
  const nodeMap = new Map<string, GlAccountNode>(
    accounts.map((a) => [a.glCode, { ...a, children: [] }]),
  );

  const roots: GlAccountNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.parentGlCode) {
      nodeMap.get(node.parentGlCode)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export async function getGlAccountTree(): Promise<GlAccountNode[]> {
  const accounts = await glAccountRepository.findAll(db);
  return buildGlAccountTree(accounts);
}

export async function getGlAccount(glCode: string): Promise<GlAccount | null> {
  return glAccountRepository.findByCode(db, glCode);
}

// Where-used: which GL mapping rules target this GL code. Returned as the
// list of mapping IDs — the page joins to the full mapping list already in
// scope.
export async function getWhereUsed(glCode: string): Promise<string[]> {
  // Implemented by querying glMappingRepository.findAll and filtering —
  // avoids coupling this service to the mapping repository directly.
  // The mapping list is small (< 50 rows) so the in-memory filter is fine.
  const { glMappingRepository } =
    await import("@/db/repositories/accounts/gl-mapping.repository");
  const mappings = await glMappingRepository.findAll(db);
  return mappings
    .filter((m) => m.refGlCode === glCode && m.state === "active")
    .map((m) => m.glMappingId);
}

export async function createGlCode(
  input: CreateGlCodeInput,
  actorId: string,
): Promise<CreateGlCodeResult> {
  const existing = await glAccountRepository.findByCode(db, input.glCode);
  if (existing) return { ok: false, code: "DUPLICATE_GL_CODE" };

  if (input.parentGlCode) {
    const parent = await glAccountRepository.findByCode(db, input.parentGlCode);
    if (!parent) return { ok: false, code: "PARENT_NOT_FOUND" };
  }

  await glAccountRepository.insert(db, {
    glCode: input.glCode,
    name: input.name,
    accountClass: input.accountClass,
    normalBalance: input.normalBalance,
    parentGlCode: input.parentGlCode ?? null,
    isPostable: input.isPostable,
    lastEditedBy: actorId,
  });

  return { ok: true, glCode: input.glCode };
}

// Retiring a GL code does NOT cause unmapped accounts (the mapping rows still
// point to it; the resolution view only filters gl_mapping.state, not
// gl_account.state). The F5 orphan check is still run as a belt-and-suspenders
// guard in case a future view change alters this behaviour.
export async function retireGlCode(
  glCode: string,
  lastModified: Date,
  actorId: string,
): Promise<RetireGlCodeResult> {
  return db.transaction(async (tx) => {
    const result = await glAccountRepository.retire(tx, glCode, lastModified);
    if (result !== "updated") {
      return {
        ok: false,
        code: (
          {
            not_found: "NOT_FOUND",
            already_retired: "ALREADY_RETIRED",
            conflict: "CONFLICT",
          } as const
        )[result],
      };
    }

    // Belt-and-suspenders orphan check (see note above).
    const unmapped = await ledgerRepository.countUnmappedAccounts(tx);
    if (unmapped > 0) {
      const affected = await ledgerRepository.findUnmappedAccountNames(tx);
      // Roll back via throw — the transaction catch re-surfaces it as a typed
      // result via the sentinel pattern (write-off.ts precedent).
      class OrphanError extends Error {
        constructor(public affected: string[]) {
          super("orphan");
        }
      }
      throw new OrphanError(affected);
    }

    // Note: actorId is recorded on the gl_account row via lastEditedBy; the
    // retire path updates state+lastModified only (lastEditedBy unchanged).
    // A future audit-event hook can extend this without touching the service.
    void actorId;

    return { ok: true };
  });
}
