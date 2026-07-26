import { pgSchema } from "drizzle-orm/pg-core";

// One shared `pgSchema("billing")` handle, imported by every file under
// `db/schema/billing/**` (ac01 already created the physical schema for the
// vendored pgledger fork — this instance is only for the module's own
// Drizzle-declared tables, ac02+).
export const billing = pgSchema("billing");
