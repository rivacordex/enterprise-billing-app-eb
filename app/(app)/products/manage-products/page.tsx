import type { Metadata } from "next";
import { Plus } from "lucide-react";

import { firstValue } from "@/lib/search-params";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { CreateOfferingDialog } from "@/components/products/manage/create-offering-dialog";
import { FamilyTable } from "@/components/products/manage/family-table";
import { SelectionRegion } from "@/components/products/manage/selection-region";
import { VersionBar } from "@/components/products/manage/version-bar";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import { listFamilies } from "@/services/product/list-families";
import { listFamilyVersions } from "@/services/product/list-family-versions";
import { resolveSelectedVersion } from "@/services/product/resolve-selected-version";
import {
  getAppLocale,
  getAppName,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import type { OfferingDetail, VersionSummary } from "@/types/product";
import { familyListSearchParamsSchema } from "@/validation/product/family-list.schema";

export const dynamic = "force-dynamic";

// Dynamic so the tab title tracks the configured `app_name` (`getAppName()` is
// `React.cache`d, so it shares the page's per-request read).
export async function generateMetadata(): Promise<Metadata> {
  return { title: `Manage Products — ${await getAppName()}` };
}

export default async function ManageProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  // products:EDIT gates the whole page (architecture §4); retire/obsolete/
  // discard's additional products:DELETE check happens per-action in the
  // withdrawal Server Actions, not here — this page never itself mutates.
  await requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT);

  const raw = await searchParams;
  const params = familyListSearchParamsSchema.parse({
    q: firstValue(raw.q),
    status: firstValue(raw.status),
    page: firstValue(raw.page),
    family: firstValue(raw.family),
    version: firstValue(raw.version),
  });

  // First render: one paged families query (+ its count) and the two config
  // reads — no per-row detail fetch (pm39 D2/§1.16, V9). The family versions are
  // fetched concurrently when a family is selected (they don't depend on the
  // list). findFamilyPage is deliberately NOT held in a data cache (pm40 D5): the
  // module has no cache layer (architecture §1), and the existing mutations
  // revalidate by path, not tag — so the families 2 statements are re-run per
  // selection. Query budget: no selection = 2; selection/version switch = 6
  // (families 2 + versions 1 + getOfferingDetail 3).
  // `family` is a local const so its truthiness narrows `string | null` → `string`
  // inside each branch below, avoiding an `as string` assertion the compiler
  // can't verify against a separate boolean.
  const family = params.family;
  const [page, locale, timezone, versions] = await Promise.all([
    listFamilies(params),
    getAppLocale(),
    getAppTimezone(),
    family
      ? listFamilyVersions(family)
      : Promise.resolve([] as VersionSummary[]),
  ]);

  // `version` is subordinate to `family` (D1): a stale/foreign `?version=` falls
  // back to the primary version silently; an unknown `?family=` resolves to null
  // and renders the empty-selection state, never a 404 (§3.3).
  const selectedVersionId = family
    ? resolveSelectedVersion(versions, params.version)
    : null;
  const selectedOffering: OfferingDetail | null = selectedVersionId
    ? await getOfferingDetail(selectedVersionId)
    : null;

  return (
    <main className="space-y-5 p-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-semibold text-foreground">
            Manage Products
          </h1>
          <p className="mt-1 text-body text-muted-foreground">
            One row per product. Select a product to open its versions. Editing
            a live version always creates a new draft — it never changes
            what&apos;s active.
          </p>
        </div>
        <CreateOfferingDialog
          trigger={
            <button
              type="button"
              aria-label="New offering"
              className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-primary-bg)] px-3 py-2 text-body-sm font-semibold text-white hover:bg-[color:var(--action-primary-bg-hover)]"
            >
              <Plus size={16} aria-hidden />
              New offering
            </button>
          }
        />
      </header>

      <FamilyTable
        page={page}
        query={params.q}
        status={params.status}
        locale={locale}
        timezone={timezone}
      />

      {/* D4 layout order: table → version bar → detail → specs → prices. The
          bar renders only when a selected family actually has versions; a
          family that matches no row falls through to SelectionRegion's empty
          state below. `key` on the region resets any subtree state per version,
          matching View Product's OfferingDetailRegion precedent. */}
      {family && versions.length > 0 && selectedVersionId ? (
        <VersionBar
          versions={versions}
          selectedVersionId={selectedVersionId}
          query={params.q}
          status={params.status}
          page={params.page}
          family={family}
        />
      ) : null}

      <SelectionRegion
        key={selectedVersionId ?? "none"}
        hasFamily={family !== null}
        offering={selectedOffering}
        locale={locale}
        timezone={timezone}
      />
    </main>
  );
}
