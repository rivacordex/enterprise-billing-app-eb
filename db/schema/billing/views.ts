import { jsonb, numeric, text } from "drizzle-orm/pg-core";

import { billing } from "@/db/schema/billing/pg-schema";

export type AccountViewRelatedParty = {
  id: string;
  role: string;
  name: string;
  "@referredType": string;
};

export type AccountViewRow = {
  accountId: string;
  accountType: string;
  name: string;
  description: string | null;
  state: string;
  currency: string;
  refPartyRoleId: string;
  relatedParty: AccountViewRelatedParty[];
};

export type GlResolutionViewRow = {
  pgledgerAccountId: string;
  glCode: string | null;
};

export type GlJournalViewRow = {
  glCode: string;
  name: string;
  period: string;
  debit: string;
  credit: string;
};

// These three views are hand-authored raw SQL (views.sql), appended to the
// migration because drizzle-kit cannot express the `billing.pgledger_*`
// joins (ac02-spec §2.4/§3.2). `.existing()` marks them read-only surfaces
// that drizzle-kit must never try to create, alter, or drop.
export const accountView = billing
  .view("account_view", {
    accountId: text("account_id").notNull(),
    accountType: text("account_type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    state: text("state").notNull(),
    currency: text("currency").notNull(),
    refPartyRoleId: text("ref_party_role_id").notNull(),
    relatedParty: jsonb("related_party")
      .$type<AccountViewRelatedParty[]>()
      .notNull(),
  })
  .existing();

export const glResolutionView = billing
  .view("gl_resolution_view", {
    pgledgerAccountId: text("pgledger_account_id").notNull(),
    glCode: text("gl_code"),
  })
  .existing();

export const glJournalView = billing
  .view("gl_journal_view", {
    glCode: text("gl_code").notNull(),
    name: text("name").notNull(),
    period: text("period").notNull(),
    debit: numeric("debit", { mode: "string" }).notNull(),
    credit: numeric("credit", { mode: "string" }).notNull(),
  })
  .existing();
