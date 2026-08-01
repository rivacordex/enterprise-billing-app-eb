import { pgSchema } from "drizzle-orm/pg-core";

// Shared `billing` pg schema instance (ac01 created the schema itself via
// raw SQL for the pgledger fork; this is the first unit to give it a Drizzle
// surface). Every table file under `db/schema/billing/` imports this same
// instance — never re-declares `pgSchema("billing")` — so drizzle-kit sees
// one schema object, not several colliding ones (ac02-spec §2.7).
export const billing = pgSchema("billing");
