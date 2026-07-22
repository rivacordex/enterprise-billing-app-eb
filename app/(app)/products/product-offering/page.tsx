import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { OfferingDetailRegion } from "@/components/products/offering-detail-region";
import { OfferingTable } from "@/components/products/offering-table";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import { listOfferings } from "@/services/product/list-offerings";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { offeringListSearchParamsSchema } from "@/validation/product/offering-list.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "View Product — Enterprise Billing",
};

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProductOfferingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  // products is page-level READ (Inv. #10) — READ gates the whole page,
  // including the future prices section; no per-section guard follows.
  await requirePermission(PERMISSIONS.PRODUCTS, LEVELS.READ);

  const raw = await searchParams;
  // Lenient parse (pm02 §3.6): every field .catch()-defaults, so a tampered
  // URL renders the default view and never 500s.
  const parsed = offeringListSearchParamsSchema.parse({
    q: firstValue(raw.q),
    status: firstValue(raw.status) ?? null,
    sort: firstValue(raw.sort),
    page: firstValue(raw.page) ?? 1,
    offering: firstValue(raw.offering) ?? null,
  });

  const timezone = getAppTimezone(); // sync accessor — outside Promise.all
  const [offeringPage, selectedOffering, locale] = await Promise.all([
    listOfferings(parsed),
    parsed.offering
      ? getOfferingDetail(parsed.offering)
      : Promise.resolve(null),
    getAppLocale(),
  ]);

  return (
    <main className="space-y-5 p-5">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">View Product</h1>
      </header>

      <Suspense>
        <OfferingTable
          rows={offeringPage.rows}
          total={offeringPage.total}
          page={offeringPage.page}
          pageSize={offeringPage.pageSize}
          selectedOfferingId={parsed.offering}
          query={parsed.q}
          status={parsed.status}
          sort={parsed.sort}
          locale={locale}
          timezone={timezone}
        />
      </Suspense>

      <OfferingDetailRegion
        key={parsed.offering ?? "none"}
        hasSelection={parsed.offering !== null}
        notFound={parsed.offering !== null && selectedOffering === null}
        offering={selectedOffering}
        locale={locale}
        timezone={timezone}
      />
    </main>
  );
}
