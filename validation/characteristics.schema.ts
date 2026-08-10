import { z } from "zod";

// A flat string→string characteristics record — the shape of both
// `ordering.product_order_item.ordered_characteristics` and
// `inventory.product_inventory.instance_characteristics` (architecture §3).
// Mirrors `productSpecCharacteristicsSchema` (pm02) for the catalog side; kept
// as one schema so create-order, update-characteristics, and the seed all
// guard the same shape (Inv. #4 — no unvalidated JSONB reaches the DB).
export const characteristicsRecordSchema = z.record(
  z.string().min(1),
  z.string(),
);

export type CharacteristicsRecord = z.infer<typeof characteristicsRecordSchema>;
