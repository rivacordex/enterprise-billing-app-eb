import { pgSchema } from "drizzle-orm/pg-core";

// Shared `rating` pg schema instance (rm01-spec §Implementation §1). Every
// table file under `db/schema/rating/` imports this same instance — never
// re-declares `pgSchema("rating")` — so drizzle-kit sees one schema object,
// not several colliding ones (billing/pg-schema.ts precedent).
export const rating = pgSchema("rating");
