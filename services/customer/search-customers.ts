import { db } from "@/db/client";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import type {
  CustomerSearchResults,
  CustomerStatus,
  OrganizationStatus,
} from "@/types/customer";

export const DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT = 5;

const LIMIT_REGEX = /^\d+$/;

// Runtime-configurable cap via `core.system_config` (`customer` /
// `CUSTOMER_SEARCH_RESULT_LIMIT`, seeded by cm01). Only a bare non-negative
// integer string `>= 1` is accepted; anything else (missing, empty,
// non-numeric, `0`, negative) falls back silently to the default — a
// missing/corrupt config row degrades gracefully, it never 500s
// (cm02-spec Design #2.2.4).
async function resolveLimit(): Promise<number> {
  const raw = await systemConfigRepository.findActiveValue(
    db,
    "customer",
    "CUSTOMER_SEARCH_RESULT_LIMIT",
  );
  if (raw === null || !LIMIT_REGEX.test(raw)) {
    return DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT;
  }
  const value = Number(raw);
  return value >= 1 ? value : DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT;
}

// Backs the search results panel (cm02-spec §3.10). An empty/whitespace-only
// query never touches the database (Design #2.2.6). Fetches `limit + 1` rows
// so `hasMore` can be derived without a second COUNT query (Design #2.2.5).
// Imports the `db` singleton internally rather than taking it as a parameter
// (cm04 deviation from cm02's original signature — see custmgmt-progress-
// tracker.md's cm04 entry): `app/**` pages cannot import `db/**` directly
// under the `boundaries/dependencies` ESLint rule, and every downstream
// spec (cm04-cm06, cm08) already assumed a single-argument call, matching
// Product Management's `services/product/*` convention.
export async function searchCustomers(
  query: string,
): Promise<CustomerSearchResults> {
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return {
      results: [],
      hasMore: false,
      limit: DEFAULT_CUSTOMER_SEARCH_RESULT_LIMIT,
      query: "",
    };
  }

  const limit = await resolveLimit();

  const escaped = trimmed.replace(/[%_\\]/g, "\\$&");
  const pattern = `%${escaped}%`;

  const rows = await partyRoleRepository.searchByOrganizationNameOrTradingName(
    db,
    pattern,
    limit + 1,
  );

  const hasMore = rows.length > limit;
  const trimmedRows = hasMore ? rows.slice(0, limit) : rows;

  return {
    results: trimmedRows.map((row) => ({
      partyRoleId: row.partyRole.partyRoleId,
      organizationId: row.organization.organizationId,
      organizationName: row.organization.name,
      tradingName: row.organization.tradingName,
      organizationStatus: row.organization.status as OrganizationStatus,
      customerStatus: row.partyRole.status as CustomerStatus,
    })),
    hasMore,
    limit,
    query: trimmed,
  };
}
