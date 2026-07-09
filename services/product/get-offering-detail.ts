import { db } from "@/db/client";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type {
  EffectivityStatus,
  OfferingDetail,
  PriceCard,
} from "@/types/product";

// Design #10 boundary semantics: `[start, successorStart)` — a price is
// `current` at its exact start instant and `superseded` at its successor's
// start instant. A future-dated successor never displaces the current
// price early (guardrail §9.4).
function resolveEffectivityStatus(
  startDateTime: Date,
  endDateTime: Date | null,
  now: Date,
): EffectivityStatus {
  if (startDateTime > now) return "future";
  if (endDateTime !== null && endDateTime <= now) return "superseded";
  return "current";
}

// Backs the offering detail + specifications + prices sections
// (pm03-spec §3.6). Returns `null` for an unknown ID without querying specs
// or prices (general §2.9 — typed result, no throw for expected control
// flow). Returns ALL price rows (superseded, current, future-dated) — none
// are filtered out (Design #9).
export async function getOfferingDetail(
  productOfferingId: string,
  now: Date = new Date(),
): Promise<OfferingDetail | null> {
  const offering = await productOfferingRepository.findDetailById(
    db,
    productOfferingId,
  );
  if (!offering) return null;

  const [specifications, priceRows] = await Promise.all([
    productSpecificationRepository.findByOfferingId(db, productOfferingId),
    productOfferingPriceRepository.findByOfferingIdWithDerivedEnd(
      db,
      productOfferingId,
    ),
  ]);

  const prices: PriceCard[] = priceRows.map((row) => ({
    ...row,
    effectivityStatus: resolveEffectivityStatus(
      row.startDateTime,
      row.endDateTime,
      now,
    ),
  }));

  return { ...offering, specifications, prices };
}
