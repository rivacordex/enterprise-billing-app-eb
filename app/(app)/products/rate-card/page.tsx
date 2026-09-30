import type { Metadata } from "next";

import { firstValue } from "@/lib/search-params";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { RateCardRowPreview } from "@/components/products/rate-card/rate-card-row-preview";
import { RateCardVersionTable } from "@/components/products/rate-card/rate-card-version-table";
import { getRateCardVersionRows } from "@/services/product/ratecard/get-version-rows";
import { listRateCardVersions } from "@/services/product/ratecard/list-versions";
import {
  getAppLocale,
  getAppName,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { rateCardListSearchParamsSchema } from "@/validation/product/ratecard-list.schema";

// pm65-spec D1/D12 — no cache anywhere on this page (Inv. #59, §1.44, guardrail
// 40): `force-dynamic`, and no `unstable_cache`, no `revalidate`, no React
// `cache()`, no module-level store around any card read. The ACTIVE version can
// change at any activation or rollback, so a cached version list or cached rows
// would contradict the database this page reports.
export const dynamic = "force-dynamic";

// Dynamic so the tab title tracks the configured `app_name` (`getAppName()` is
// `React.cache`d — a per-request memo of a config read, NOT a cache of any card
// data, so it does not touch guardrail 40).
export async function generateMetadata(): Promise<Metadata> {
  return { title: `Rate Card — ${await getAppName()}` };
}

export default async function RateCardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  // ratecard:READ gates the whole read surface (architecture §4). The three
  // mutations (upload/activate/rollback) re-check ratecard:EDIT at their own
  // action guards (pm61/pm63/pm64); this page never itself mutates, and every
  // mutating control is absent, not disabled (D11).
  await requirePermission(PERMISSIONS.RATECARD, LEVELS.READ);

  const raw = await searchParams;
  // Lenient parse (§3.17): a tampered or stale URL renders defaults, never a
  // 500. `tab` is admitted (C3) and parsed here so pm66 inherits a working
  // deep-link contract; pm65 renders only the `rows` view — the diff/validation
  // views and the diff read are pm66's (see the tracker's pm65 note).
  const params = rateCardListSearchParamsSchema.parse({
    version: firstValue(raw.version) ?? null,
    page: firstValue(raw.page) ?? 1,
    q: firstValue(raw.q),
    tab: firstValue(raw.tab),
  });

  const timezone = getAppTimezone(); // sync accessor — outside Promise.all

  // First render: one versions read (listRateCardVersions) + the locale config
  // read, and NOTHING per row (§1.16/§3.23). No eager rows or diff read.
  const [versions, locale] = await Promise.all([
    listRateCardVersions(),
    getAppLocale(),
  ]);

  // `version` is parsed against the RCV format schema before this point; here
  // it is resolved against the loaded list. A well-formed id that matches no
  // row selects nothing and renders the empty-selection state — not a 404 and
  // not an error boundary (§3.17, D1, test 4). Membership in the already-loaded
  // list is authoritative (listRateCardVersions returns every version), so an
  // unknown version costs no extra query.
  const selectedVersionId =
    params.version !== null &&
    versions.some((v) => v.ratecardVersionId === params.version)
      ? params.version
      : null;

  // One paged rows read (count + select) only when a version is actually
  // selected (§3.23). No selection → no rows query at all.
  const rowsPage = selectedVersionId
    ? await getRateCardVersionRows(selectedVersionId, {
        page: params.page,
        filter: params.q,
      })
    : null;

  const versionNotFound = params.version !== null && selectedVersionId === null;

  return (
    <main className="space-y-5 p-5">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">Rate Card</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Every rate-card version the system has. Select a version to preview
          its rows.
        </p>
      </header>

      <RateCardVersionTable
        versions={versions}
        selectedVersionId={selectedVersionId}
        locale={locale}
        timezone={timezone}
      />

      {/* `key` resets any preview subtree state per selected version, matching
          the View Product / Manage Products region precedent. */}
      {rowsPage && selectedVersionId ? (
        <RateCardRowPreview
          key={selectedVersionId}
          versionId={selectedVersionId}
          rows={rowsPage.rows}
          total={rowsPage.total}
          page={rowsPage.page}
          pageSize={rowsPage.pageSize}
          query={params.q}
        />
      ) : (
        <div className="rounded-md bg-[color:var(--surface-sunken)] p-8 text-center text-body text-muted-foreground">
          {versionNotFound
            ? "That version was not found. Pick a version from the list above."
            : "Select a version to preview its rows."}
        </div>
      )}
    </main>
  );
}
