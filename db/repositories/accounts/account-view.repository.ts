import { and, eq, ilike } from "drizzle-orm";
import { char, jsonb, text } from "drizzle-orm/pg-core";

import type { Database } from "@/db/client";
import { billing } from "@/db/schema/billing/schema";
import type { Contact } from "@/validation/accounts/contact.schema";
import type {
  AccountState,
  TmfAccountRef,
  TmfRelatedParty,
} from "@/types/accounts";

// `account_view` is raw SQL (ac02-spec §2.4 — it joins `customer.*` and isn't
// itself a Drizzle-managed object), so it's declared here as an `.existing()`
// view: a typed read handle over a view the migration already created,
// carrying no DDL of its own (drizzle-kit never diffs it). This is the sole
// producer of `TmfAccountRef` (code-standards §2.6) — no page assembles the
// TMF shape ad hoc.
const accountView = billing
  .view("account_view", {
    accountId: text("account_id"),
    accountType: text("account_type"),
    name: text("name"),
    description: text("description"),
    state: text("state"),
    currency: char("currency", { length: 3 }),
    contact: jsonb("contact").$type<Contact>(),
    relatedParty: jsonb("related_party").$type<TmfRelatedParty[]>(),
  })
  .existing();

function mapRow(row: typeof accountView.$inferSelect): TmfAccountRef {
  return {
    id: row.accountId!,
    accountType: row.accountType as TmfAccountRef["accountType"],
    name: row.name!,
    description: row.description,
    state: row.state as AccountState,
    currency: row.currency!,
    relatedParty: row.relatedParty ?? [],
  };
}

export const accountViewRepository = {
  async findByAccountId(
    db: Database,
    accountId: string,
  ): Promise<TmfAccountRef | null> {
    const [row] = await db
      .select()
      .from(accountView)
      .where(eq(accountView.accountId, accountId))
      .limit(1);
    return row ? mapRow(row) : null;
  },

  // `namePattern` is the caller's already-escaped, already-wrapped (`%…%`)
  // ILIKE pattern, matching `partyRoleRepository.searchByOrganizationName…`'s
  // convention (cm02-spec §3.8) — no query-building logic lives here beyond
  // the filter itself.
  async search(
    db: Database,
    opts: {
      accountType?: TmfAccountRef["accountType"];
      namePattern?: string;
      limit: number;
    },
  ): Promise<TmfAccountRef[]> {
    const rows = await db
      .select()
      .from(accountView)
      .where(
        and(
          opts.accountType
            ? eq(accountView.accountType, opts.accountType)
            : undefined,
          opts.namePattern
            ? ilike(accountView.name, opts.namePattern)
            : undefined,
        ),
      )
      .limit(opts.limit);
    return rows.map(mapRow);
  },
};
