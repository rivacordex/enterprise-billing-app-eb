import { db } from "@/db/client";
import { glAccountRepository } from "@/db/repositories/accounts/gl-account.repository";
import { glMappingRepository } from "@/db/repositories/accounts/gl-mapping.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import type { GlMapping } from "@/db/schema/billing/catalogs";
import type { UpsertGlMappingInput } from "@/validation/accounts/gl-mapping.schema";

export type { GlMapping };

export type UpsertGlMappingResult =
  | { ok: true; glMappingId: string }
  | { ok: false; code: "NON_POSTABLE_TARGET" }
  | { ok: false; code: "GL_CODE_NOT_FOUND" }
  | { ok: false; code: "DUPLICATE_SELECTOR" }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "ORPHAN_BLOCK"; affectedAccounts: string[] };

export type RetireGlMappingResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "ALREADY_RETIRED" }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "ORPHAN_BLOCK"; affectedAccounts: string[] };

export async function listGlMappings(): Promise<GlMapping[]> {
  return glMappingRepository.findAll(db);
}

// F5 orphan-block (ac12-spec §2.3): applies the proposed change inside a
// transaction, then re-counts unmapped pgledger accounts from
// gl_resolution_view. The change is blocked only when the post-change count
// EXCEEDS the pre-change count — repairs that reduce the unmapped count are
// allowed to commit.
class OrphanBlockError extends Error {
  constructor(public affectedAccounts: string[]) {
    super("orphan-block");
  }
}

export async function upsertGlMapping(
  input: UpsertGlMappingInput,
  actorId: string,
): Promise<UpsertGlMappingResult> {
  const currency = input.currency ?? null;
  const isEdit = !!input.glMappingId;

  try {
    return await db.transaction(async (tx) => {
      // Target GL code validation inside the transaction to avoid TOCTOU races.
      const targetAccount = await glAccountRepository.findByCode(
        tx,
        input.refGlCode,
      );
      if (!targetAccount) return { ok: false, code: "GL_CODE_NOT_FOUND" };
      if (!targetAccount.isPostable)
        return { ok: false, code: "NON_POSTABLE_TARGET" };

      // Duplicate-selector guard (UNIQUE constraint proxy — gives a typed
      // result instead of a DB exception).
      const duplicate = await glMappingRepository.findDuplicateSelector(
        tx,
        input.selectorType,
        input.selector,
        currency,
        isEdit ? (input.glMappingId ?? undefined) : undefined,
      );
      if (duplicate) return { ok: false, code: "DUPLICATE_SELECTOR" };

      // Baseline unmapped count before the provisional change.
      const unmappedBefore = await ledgerRepository.countUnmappedAccounts(tx);

      let glMappingId: string;

      if (isEdit) {
        // Missing lastModified on an edit = optimistic-lock data absent → CONFLICT.
        if (!input.lastModified) return { ok: false, code: "CONFLICT" };
        const existing = await glMappingRepository.findById(
          tx,
          input.glMappingId!,
        );
        if (!existing) return { ok: false, code: "NOT_FOUND" };
        if (
          existing.lastModified.getTime() !==
          new Date(input.lastModified).getTime()
        ) {
          return { ok: false, code: "CONFLICT" };
        }

        const updated = await glMappingRepository.update(
          tx,
          input.glMappingId!,
          {
            selectorType: input.selectorType,
            selector: input.selector,
            currency,
            refGlCode: input.refGlCode,
            lastEditedBy: actorId,
          },
        );
        if (!updated) return { ok: false, code: "NOT_FOUND" };
        glMappingId = updated.glMappingId;
      } else {
        const inserted = await glMappingRepository.insert(tx, {
          selectorType: input.selectorType,
          selector: input.selector,
          currency,
          refGlCode: input.refGlCode,
          lastEditedBy: actorId,
        });
        glMappingId = inserted.glMappingId;
      }

      // F5 prospective orphan check — only block if this change introduces new
      // unmapped accounts (count increases). Repairs that reduce the count commit.
      const unmappedAfter = await ledgerRepository.countUnmappedAccounts(tx);
      if (unmappedAfter > unmappedBefore) {
        const affected = await ledgerRepository.findUnmappedAccountNames(tx);
        throw new OrphanBlockError(affected);
      }

      return { ok: true, glMappingId };
    });
  } catch (e) {
    if (e instanceof OrphanBlockError) {
      return {
        ok: false,
        code: "ORPHAN_BLOCK",
        affectedAccounts: e.affectedAccounts,
      };
    }
    throw e;
  }
}

export async function retireGlMapping(
  glMappingId: string,
  lastModified: Date,
  actorId: string,
): Promise<RetireGlMappingResult> {
  try {
    return await db.transaction(async (tx) => {
      // Baseline unmapped count before the retirement.
      const unmappedBefore = await ledgerRepository.countUnmappedAccounts(tx);

      const result = await glMappingRepository.retire(
        tx,
        glMappingId,
        lastModified,
        actorId,
      );
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

      // F5 orphan check — only block if the retirement introduces NEW orphans.
      const unmappedAfter = await ledgerRepository.countUnmappedAccounts(tx);
      if (unmappedAfter > unmappedBefore) {
        const affected = await ledgerRepository.findUnmappedAccountNames(tx);
        throw new OrphanBlockError(affected);
      }

      return { ok: true };
    });
  } catch (e) {
    if (e instanceof OrphanBlockError) {
      return {
        ok: false,
        code: "ORPHAN_BLOCK",
        affectedAccounts: e.affectedAccounts,
      };
    }
    throw e;
  }
}
