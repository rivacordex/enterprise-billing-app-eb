import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { ManageOfferingTable } from "@/components/products/manage/manage-offering-table";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import { listOfferings } from "@/services/product/list-offerings";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import type {
  LifecycleStatus,
  OfferingFamilyRow,
  OfferingListRow,
  SpecificationCard,
} from "@/types/product";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Manage Products — Enterprise Billing",
};

const MAX_COMBINED_ROWS = 1000; // defensive ceiling — see pm18-spec §2.2

// Loops the existing, unmodified `listOfferings` export across every page
// for one status bucket. Two calls (null, "RETIRED") together cover every
// lifecycle status — `listOfferings` itself never accepts "give me
// everything" in one call (pm18-spec §2.2).
async function fetchAllForStatus(
  status: LifecycleStatus | null,
): Promise<OfferingListRow[]> {
  const collected: OfferingListRow[] = [];
  let page = 1;
  for (;;) {
    const result = await listOfferings({
      q: "",
      status,
      sort: "name",
      page,
      offering: null,
    });
    collected.push(...result.rows);
    if (
      collected.length >= result.total ||
      result.rows.length === 0 ||
      collected.length > MAX_COMBINED_ROWS
    ) {
      break;
    }
    page += 1;
  }
  if (collected.length > MAX_COMBINED_ROWS) {
    throw new Error(
      "fetchAllForStatus: exceeded the combined-row safety ceiling",
    );
  }
  return collected;
}

async function fetchAllOfferingRows(): Promise<OfferingListRow[]> {
  const [nonRetired, retired] = await Promise.all([
    fetchAllForStatus(null),
    fetchAllForStatus("RETIRED"),
  ]);
  return [...nonRetired, ...retired];
}

function resolveFamilyId(row: OfferingListRow): string {
  return row.familyOfferingId ?? row.productOfferingId;
}

function selectPrimary(versions: OfferingListRow[]): OfferingListRow {
  const active = versions.find((row) => row.lifecycleStatus === "ACTIVE");
  if (active) return active;
  return versions.reduce((highest, row) =>
    row.version > highest.version ? row : highest,
  );
}

// pm21-spec §2.3/§3.1. Reuses the existing, unmodified getOfferingDetail
// export — no new repository method, no new service, no widened
// OfferingListRow. Discards `prices`/other detail fields; only
// `specifications` is kept.
async function fetchSpecificationsByOfferingId(
  rows: OfferingListRow[],
): Promise<Record<string, SpecificationCard[]>> {
  const entries = await Promise.all(
    rows.map(async (row) => {
      const detail = await getOfferingDetail(row.productOfferingId);
      return [row.productOfferingId, detail?.specifications ?? []] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function groupIntoFamilies(rows: OfferingListRow[]): OfferingFamilyRow[] {
  const byFamily = new Map<string, OfferingListRow[]>();
  for (const row of rows) {
    const familyId = resolveFamilyId(row);
    const existing = byFamily.get(familyId);
    if (existing) {
      existing.push(row);
    } else {
      byFamily.set(familyId, [row]);
    }
  }

  const families: OfferingFamilyRow[] = [];
  for (const [familyId, versions] of byFamily) {
    const sorted = [...versions].sort((a, b) => b.version - a.version);
    families.push({
      familyId,
      primary: selectPrimary(sorted),
      versions: sorted,
    });
  }

  return families.sort((a, b) => a.primary.name.localeCompare(b.primary.name));
}

export default async function ManageProductsPage(): Promise<React.JSX.Element> {
  // products:EDIT gates the whole page (architecture-phase2 §4); retire/
  // discard's additional products:DELETE check happens per-action in pm23's
  // Server Actions, not here — this page never itself performs a mutation.
  await requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT);

  const [rows, locale, timezone] = await Promise.all([
    fetchAllOfferingRows(),
    getAppLocale(),
    getAppTimezone(),
  ]);
  const families = groupIntoFamilies(rows);
  const specificationsByOfferingId =
    await fetchSpecificationsByOfferingId(rows);

  return (
    <main className="space-y-5 p-5">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">
          Manage Products
        </h1>
        <p className="mt-1 text-body text-muted-foreground">
          One row per product family. Editing a live version always creates a
          new draft — it never changes what&apos;s active.
        </p>
      </header>

      <Suspense>
        <ManageOfferingTable
          families={families}
          locale={locale}
          timezone={timezone}
          specificationsByOfferingId={specificationsByOfferingId}
        />
      </Suspense>
    </main>
  );
}
