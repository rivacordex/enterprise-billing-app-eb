import { z } from "zod";

// rm18-spec §Implementation §2. The MNO-key entry inside
// `party_role.party_role_specification` — a numbered series, single key
// required for now (multi-key is a future phase). `passthrough()` because
// `party_role_specification` is the platform's well-formed-JSON-only jsonb
// (custmgmt Inv. #7) and may carry other keys. The resolver (rm20) reads
// `->>'mnoPublicKey1'`; this shape is what the ordering/seed side writes.
export const mnoKeySpecSchema = z
  .object({ mnoPublicKey1: z.string().min(1) })
  .passthrough();
export type MnoKeySpec = z.infer<typeof mnoKeySpecSchema>;
