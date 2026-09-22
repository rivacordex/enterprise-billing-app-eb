import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { productOfferingPrice } from "@/db/schema/product";
import type { ComponentType, UnitOfMeasure } from "@/types/product";

// pm49-spec D4/I3, code-standards §2.14. The module's first cross-row
// (offering-level) validator — VI1/VI2 are per-row and live in pm47's Zod
// branch; VI3–VI5 read the offering's *other* rows and live here, the one
// place they may ever be checked (D6 — a second copy anywhere else is
// drift). `tx` is the first argument so the function cannot be called
// outside a transaction (§2.14) — the signature is the enforcement, not a
// comment.
export type OfferingComponentViolation =
  | "MODIFIER_WITHOUT_BASE_RATE"
  | "AMBIGUOUS_BASE_RATE"
  | "CURRENCY_MISMATCH";

export type ValidateOfferingComponentsResult =
  | { ok: true }
  | {
      ok: false;
      code: "MODIFIER_WITHOUT_BASE_RATE";
      unitOfMeasure: UnitOfMeasure;
    }
  | { ok: false; code: "AMBIGUOUS_BASE_RATE" }
  | {
      ok: false;
      code: "CURRENCY_MISMATCH";
      existingCurrency: string;
      candidateCurrency: string;
    };

// The write this call is about to make, in the shape the validator needs to
// fold it into the offering's evaluated component set (D4). `insert`/`update`
// add the candidate's own values to the sibling set; `delete` removes only
// the target row — there is no candidate to add, so the currency (VI5) and
// ambiguity (VI4) checks, which only ever compare *against* a candidate,
// never fire for a delete. `update`/`delete` carry `productOfferingPriceId`
// so the target row is excluded from the sibling read before the candidate
// (if any) is folded back in.
export type OfferingComponentCandidate =
  | {
      kind: "insert";
      componentType: ComponentType;
      unitOfMeasure: UnitOfMeasure | null;
      currency: string;
      startDateTime: Date;
    }
  | {
      kind: "update";
      productOfferingPriceId: string;
      componentType: ComponentType;
      unitOfMeasure: UnitOfMeasure | null;
      currency: string;
      startDateTime: Date;
    }
  | { kind: "delete"; productOfferingPriceId: string };

interface EvaluatedComponent {
  componentType: ComponentType;
  unitOfMeasure: UnitOfMeasure | null;
  currency: string;
  startDateTime: Date;
}

// Validates the offering *as it would be after the write* — for an insert,
// siblings + candidate; for an update, siblings with the target row replaced
// by the candidate's new values; for a delete, siblings minus the target.
// This is what makes "deleting the last usage_rate while a capacity_commitment
// still binds to it" a MODIFIER_WITHOUT_BASE_RATE refusal rather than a
// silently orphaned modifier — deletePrice folds no candidate in, so the
// modifier that remains in the evaluated set simply has nothing to point at
// (pm49-spec D4). This is the single most likely thing for a later change to
// get wrong: do not evaluate the candidate against the CURRENT (pre-write)
// state, and do not skip the modifier check just because this call is a
// delete.
export async function validateOfferingComponents(
  tx: Database,
  offeringId: string,
  candidate: OfferingComponentCandidate,
): Promise<ValidateOfferingComponentsResult> {
  // One sibling read on `tx`, after the caller's DRAFT lock (§1.13) — every
  // component of the offering, ordered deterministically so a multi-violation
  // case reports the same violation every time (I3).
  const siblingRows = await tx
    .select({
      productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
      componentType: productOfferingPrice.componentType,
      unitOfMeasure: productOfferingPrice.unitOfMeasure,
      currency: productOfferingPrice.currency,
      startDateTime: productOfferingPrice.startDateTime,
    })
    .from(productOfferingPrice)
    .where(eq(productOfferingPrice.productOfferingId, offeringId))
    .orderBy(
      asc(productOfferingPrice.componentType),
      asc(productOfferingPrice.unitOfMeasure),
      asc(productOfferingPrice.startDateTime),
      asc(productOfferingPrice.productOfferingPriceId),
    );

  const excludeId =
    candidate.kind === "update" || candidate.kind === "delete"
      ? candidate.productOfferingPriceId
      : null;

  const evaluated: EvaluatedComponent[] = siblingRows
    .filter((row) => row.productOfferingPriceId !== excludeId)
    .map((row) => ({
      componentType: row.componentType as ComponentType,
      unitOfMeasure: row.unitOfMeasure as UnitOfMeasure | null,
      currency: row.currency,
      startDateTime: row.startDateTime,
    }));

  if (candidate.kind === "insert" || candidate.kind === "update") {
    evaluated.push({
      componentType: candidate.componentType,
      unitOfMeasure: candidate.unitOfMeasure,
      currency: candidate.currency,
      startDateTime: candidate.startDateTime,
    });
  }

  // 1. Currency (VI5) — cheapest, offering-wide. Only meaningful against a
  // candidate; a delete can only ever shrink the currency set.
  if (candidate.kind === "insert" || candidate.kind === "update") {
    for (const row of evaluated) {
      if (row.currency !== candidate.currency) {
        return {
          ok: false,
          code: "CURRENCY_MISMATCH",
          existingCurrency: row.currency,
          candidateCurrency: candidate.currency,
        };
      }
    }
  }

  // 2. Base-rate presence (VI3) — a post_aggregation modifier needs a
  // same-unit usage_rate somewhere in the evaluated set. Scans every modifier
  // in the set, not just the candidate: this is what catches "delete the last
  // same-unit usage_rate out from under a modifier".
  for (const row of evaluated) {
    if (
      row.componentType === "capacity_commitment" ||
      row.componentType === "capacity_motivation"
    ) {
      const hasBaseRate = evaluated.some(
        (other) =>
          other.componentType === "usage_rate" &&
          other.unitOfMeasure === row.unitOfMeasure,
      );
      if (!hasBaseRate) {
        return {
          ok: false,
          code: "MODIFIER_WITHOUT_BASE_RATE",
          // A modifier's row always carries a non-null unit (pm46's
          // per-component-type CHECK), so this narrows safely.
          unitOfMeasure: row.unitOfMeasure as UnitOfMeasure,
        };
      }
    }
  }

  // 3. Ambiguity (VI4) — validated AT THE INSTANT being validated (D5): two
  // usage_rate rows for the same unit are ambiguous only if they share the
  // exact same start_date_time. A dated successor (different start) is a
  // legitimate future effective row, never ambiguous — do not invent a
  // period-wide resolution rule here (O5 is out of scope).
  const seenInstants = new Set<string>();
  for (const row of evaluated) {
    if (row.componentType !== "usage_rate") continue;
    const key = `${row.unitOfMeasure ?? ""}|${row.startDateTime.getTime()}`;
    if (seenInstants.has(key)) {
      return { ok: false, code: "AMBIGUOUS_BASE_RATE" };
    }
    seenInstants.add(key);
  }

  return { ok: true };
}
