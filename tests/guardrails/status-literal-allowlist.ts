// pm45-spec I3 / D3 — the committed allow-list for guardrail 30's status-literal
// sweep (status-literal-sweep.test.ts). Every bare `'RETIRED'` / `'OBSOLETE'`
// string literal in production source — outside the two files where the union
// is legitimately DEFINED, `db/schema/product.ts` and `types/product.ts` — must
// appear here with a one-line reason, or CI fails. A new comparison added later
// fails until it is justified with an entry (D3). Each occurrence of a literal
// in a file collapses to one `{ file, literal }` pair; the reason covers every
// occurrence of that literal in that file.
//
// Guardrail 30 does NOT prove OBSOLETE bills (I3). It proves the *absence* of a
// literal that would treat a pinned version as unbillable/unreadable outside the
// module's own home. The bill run never reads `lifecycle_status` — it resolves
// by the pinned `product_offering_id` (Inv. #17) — so "nothing treats OBSOLETE
// as unbillable" is vacuously true there. The real proof that an OBSOLETE-pinned
// subscription still bills is pm43's price-stability integration test
// (product-withdrawal-path.integration.test.ts) plus ship-gate guardrail 16.

export type StatusLiteralAllowEntry = {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** The exact bare status literal found. */
  literal: "RETIRED" | "OBSOLETE";
  /** One line: why this occurrence is legitimate. */
  reason: string;
};

export const STATUS_LITERAL_ALLOWLIST: StatusLiteralAllowEntry[] = [
  // ── Product module's own home: db/** and services/product/** (guardrail 30 §9
  //    names both as allowed). Listed anyway because D3's sweep exclusion is
  //    narrower (only the two definition files), so the module's own writers and
  //    guards are enumerated here for completeness and review.
  {
    file: "db/repositories/product-offering.ts",
    literal: "OBSOLETE",
    reason:
      "Product repository: default View-Product filter hides OBSOLETE (pm37 D4); markObsolete writes it and retireOffering pins it in its WHERE (services' status home).",
  },
  {
    file: "db/repositories/product-offering.ts",
    literal: "RETIRED",
    reason:
      "Product repository: default View-Product filter hides RETIRED (pm37 D4); retireOffering writes the terminal RETIRED status.",
  },
  {
    file: "services/product/activate-offering.ts",
    literal: "OBSOLETE",
    reason:
      "Activation supersedes the family's previous ACTIVE version to OBSOLETE in the same transaction (pm42 D3) — the audit afterData it records.",
  },
  {
    file: "services/product/obsolete-offering.ts",
    literal: "OBSOLETE",
    reason:
      "Stop-selling service (ACTIVE → OBSOLETE): the status it writes and its audit afterData (pm43 I3).",
  },
  {
    file: "services/product/retire-offering.ts",
    literal: "OBSOLETE",
    reason:
      "Retire gates on the OBSOLETE predecessor (OFFERING_NOT_OBSOLETE) and records it as audit beforeData (pm43 I4).",
  },
  {
    file: "services/product/retire-offering.ts",
    literal: "RETIRED",
    reason:
      "Retire writes the terminal RETIRED status as its audit afterData (pm43 I4).",
  },
  {
    file: "services/product/add-specification.ts",
    literal: "RETIRED",
    reason:
      "Edit-guard: a spec write against a RETIRED offering is refused with OFFERING_RETIRED (§1.10) — a refusal, never an unbillable/unreadable treatment.",
  },
  {
    file: "services/product/update-specification.ts",
    literal: "RETIRED",
    reason:
      "Edit-guard: a spec update against a RETIRED offering is refused with OFFERING_RETIRED (§1.10).",
  },
  {
    file: "services/product/delete-specification.ts",
    literal: "RETIRED",
    reason:
      "Edit-guard: a spec delete against a RETIRED offering is refused with OFFERING_RETIRED (§1.10).",
  },
  {
    file: "services/product/update-offering.ts",
    literal: "RETIRED",
    reason:
      "Edit-guard: an offering edit against a RETIRED version is refused with OFFERING_RETIRED (§1.10, Inv. #14).",
  },
  {
    file: "services/product/insert-price.ts",
    literal: "RETIRED",
    reason:
      "Edit-guard: a price insert against a RETIRED offering is refused with OFFERING_RETIRED (§1.10).",
  },

  // ── Product surfaces OUTSIDE db/** and services/product/**: the one place a
  //    page reads the OBSOLETE status, and it is a display decision, not a
  //    billing/readability one.
  {
    file: "app/(app)/products/manage-products/page.tsx",
    literal: "OBSOLETE",
    reason:
      "Manage Products fetches the live-subscription count only for an OBSOLETE selection to feed the Retire blocked-state (pm43 I7) — a display decision, not an unbillable/unreadable treatment; the version still bills.",
  },

  // ── Unrelated domain: system-config has its OWN DRAFT/ACTIVE/RETIRED status
  //    enum. These are not the product lifecycle and never touch a pinned
  //    offering version.
  {
    file: "types/system-config.ts",
    literal: "RETIRED",
    reason:
      "system-config module: its own CONFIG_STATUSES union (DRAFT/ACTIVE/RETIRED) — unrelated to product lifecycle.",
  },
  {
    file: "db/schema/system-config.ts",
    literal: "RETIRED",
    reason:
      "system-config module: CHECK constraint on its own status enum — unrelated to product lifecycle.",
  },
  {
    file: "components/system-config/config-table.tsx",
    literal: "RETIRED",
    reason:
      "system-config module: dims a RETIRED config-item row — unrelated to product lifecycle.",
  },
];
