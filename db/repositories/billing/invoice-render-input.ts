import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import { document } from "@/db/schema/billing/documents";
import { contactMedium, organization, partyRole } from "@/db/schema/customer";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import {
  ratedLinesRepository,
  type BilledUsageResult,
} from "@/db/repositories/billing/rated-lines.repository";
import { INVOICE_USAGE_ROW_LIMIT } from "@/types/billing";
import type {
  ChargeSource,
  InvoiceAddress,
  LineType,
  PostedBillStamps,
} from "@/types/billing";

// bm47-spec §Implementation §3 — the binder's only repository (D1). Every
// amount is selected `::text` (code-standards §2.3); no JS arithmetic on
// money anywhere in this file — group/bill-level subtotals are SQL `SUM`s
// (D2/D3). No rating-schema reference: the bm49 usage read is delegated to
// `ratedLinesRepository.listBilledUsageForInvoice` (the R9 home of the read),
// so this file still never touches the rating schema (file-org rule 2 boundary
// test).

// bm49-spec §Design D5 — the usage read result the binder reconciles and
// shapes: the over-limit marker (D3) or the billed rows + GROUPING SETS
// subtotals. `null` on `RawInvoiceRenderInput.usage` when the annex section is
// hidden (`includeUsage: false`, D4) and the read is skipped.
export type RawInvoiceUsage = BilledUsageResult;

export interface RawInvoiceLine {
  lineNo: number;
  source: ChargeSource;
  lineType: LineType;
  description: string | null;
  refProductOfferingId: string;
  udrType: string | null;
  udrCount: number | null;
  quantity: string | null;
  unit: string | null;
  snapshotQuantity: string | null;
  snapshotUnitPrice: string | null;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  discountRate: string | null;
  // SQL window sums `OVER (PARTITION BY source)` — the group's own totals,
  // identical on every line of that group (D3).
  groupGrossTotal: string;
  groupDiscountTotal: string;
  groupNetTotal: string;
}

export interface RawInvoiceRenderInput {
  bill: {
    customerBillId: string;
    periodPartition: string;
    billingAccountId: string;
    currency: string;
    billingPeriodStart: string;
    billingPeriodEnd: string;
    paymentDueDate: string;
    subtotal: string;
    taxTotal: string;
    totalAmount: string;
    // D2 — compared as strings against `subtotal` before anything is bound.
    linesNetSum: string;
    grossTotal: string;
    discountTotal: string;
    // bm49-spec §Implementation §2 / §Design D6 — `SUM(rated_amount) FILTER
    // (WHERE source = 'USAGE')`; the usage annex's grand total must equal it
    // (bm44: `rated_amount` is anchored on the same `udr_rated` rows the annex
    // itemises). Compared as a string in `bind()` (no new error code).
    usageRatedTotal: string;
  };
  run: { billRunId: string; cycleName: string };
  lines: RawInvoiceLine[];
  taxItems: { category: string; rate: string; amount: string }[];
  // final only; `null` on a draft (no `billing.document` row yet).
  document: { documentId: string; postingDate: Date | null } | null;
  customer: {
    name: string;
    tradingName: string | null;
    registrationNumber: string | null;
    taxId: string | null;
    email: string | null;
    phone: string | null;
    address: InvoiceAddress | null;
  };
  // bm49 (D4) — `null` when the annex section is hidden (`includeUsage:
  // false`); otherwise the usage read result (which itself may be the
  // over-limit marker, D3).
  usage: RawInvoiceUsage | null;
}

async function readBillHeader(
  tx: Database,
  runId: string,
  banId: string,
): Promise<{
  customerBillId: string;
  periodPartition: string;
  billingAccountId: string;
  currency: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  paymentDueDate: string;
  subtotal: string;
  taxTotal: string;
  totalAmount: string;
  refPartyRoleId: string;
  billRunId: string;
  cycleName: string;
  // bm49-spec §Implementation §2 — `bill_run_account.attempt_count`, the
  // same value `post-run.ts` stamps as `posted_attempt`; it scopes the
  // usage read to the attempt the bill was built on (D2).
  attempt: number;
} | null> {
  const [row] = await tx
    .select({
      customerBillId: customerBill.customerBillId,
      periodPartition: customerBill.periodPartition,
      billingAccountId: customerBill.refBillingAccountId,
      billingPeriodStart: customerBill.billingPeriodStart,
      billingPeriodEnd: customerBill.billingPeriodEnd,
      paymentDueDate: customerBill.paymentDueDate,
      subtotal: customerBill.subtotal,
      taxTotal: customerBill.taxTotal,
      totalAmount: customerBill.totalAmount,
      currency: billingAccount.currency,
      refPartyRoleId: billingAccount.refPartyRoleId,
      billRunId: billRun.billRunId,
      cycleName: billCycle.name,
      attempt: billRunAccount.attemptCount,
    })
    .from(customerBill)
    .innerJoin(billRun, eq(billRun.billRunId, customerBill.refBillRunId))
    .innerJoin(billCycle, eq(billCycle.billCycleId, billRun.refBillCycleId))
    .innerJoin(
      billingAccount,
      eq(billingAccount.billingAccountId, customerBill.refBillingAccountId),
    )
    .innerJoin(
      billRunAccount,
      and(
        eq(billRunAccount.refBillRunId, customerBill.refBillRunId),
        eq(
          billRunAccount.refBillingAccountId,
          customerBill.refBillingAccountId,
        ),
        eq(billRunAccount.periodPartition, customerBill.periodPartition),
      ),
    )
    .where(
      and(
        eq(customerBill.refBillRunId, runId),
        eq(customerBill.refBillingAccountId, banId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function readLines(
  tx: Database,
  customerBillId: string,
  periodPartition: string,
): Promise<{
  lines: RawInvoiceLine[];
  linesNetSum: string;
  grossTotal: string;
  discountTotal: string;
  usageRatedTotal: string;
}> {
  const scope = and(
    eq(customerBillLine.refCustomerBillId, customerBillId),
    eq(customerBillLine.periodPartition, periodPartition),
  );

  const rows = await tx
    .select({
      lineNo: customerBillLine.lineNo,
      source: customerBillLine.source,
      lineType: customerBillLine.lineType,
      description: customerBillLine.description,
      refProductOfferingId: customerBillLine.refProductOfferingId,
      udrType: customerBillLine.udrType,
      udrCount: customerBillLine.udrCount,
      quantity: customerBillLine.quantity,
      unit: customerBillLine.unit,
      snapshotQuantity: customerBillLine.snapshotQuantity,
      snapshotUnitPrice: customerBillLine.snapshotUnitPrice,
      grossAmount: customerBillLine.grossAmount,
      discountAmount: customerBillLine.discountAmount,
      netAmount: customerBillLine.netAmount,
      discountRate: customerBillLine.discountRate,
      groupGrossTotal: sql<string>`COALESCE(SUM(${customerBillLine.grossAmount}) OVER (PARTITION BY ${customerBillLine.source}), 0)::numeric(18,2)::text`,
      groupDiscountTotal: sql<string>`COALESCE(SUM(${customerBillLine.discountAmount}) OVER (PARTITION BY ${customerBillLine.source}), 0)::numeric(18,2)::text`,
      groupNetTotal: sql<string>`COALESCE(SUM(${customerBillLine.netAmount}) OVER (PARTITION BY ${customerBillLine.source}), 0)::numeric(18,2)::text`,
    })
    .from(customerBillLine)
    .where(scope)
    .orderBy(asc(customerBillLine.lineNo));

  const [sums] = await tx
    .select({
      linesNetSum: sql<string>`COALESCE(SUM(${customerBillLine.netAmount}), 0)::numeric(18,2)::text`,
      grossTotal: sql<string>`COALESCE(SUM(${customerBillLine.grossAmount}), 0)::numeric(18,2)::text`,
      discountTotal: sql<string>`COALESCE(SUM(${customerBillLine.discountAmount}), 0)::numeric(18,2)::text`,
      // bm49 §Design D6 — the rated side of the usage reconciliation.
      usageRatedTotal: sql<string>`COALESCE(SUM(${customerBillLine.ratedAmount}) FILTER (WHERE ${customerBillLine.source} = 'USAGE'), 0)::numeric(18,2)::text`,
    })
    .from(customerBillLine)
    .where(scope);

  return {
    lines: rows.map((r) => ({
      ...r,
      source: r.source as ChargeSource,
      lineType: r.lineType as LineType,
    })),
    linesNetSum: sums?.linesNetSum ?? "0.00",
    grossTotal: sums?.grossTotal ?? "0.00",
    discountTotal: sums?.discountTotal ?? "0.00",
    usageRatedTotal: sums?.usageRatedTotal ?? "0.00",
  };
}

async function readDocument(
  tx: Database,
  customerBillId: string,
  periodPartition: string,
): Promise<{ documentId: string; postingDate: Date | null } | null> {
  const [row] = await tx
    .select({ documentId: document.documentId, postingDate: document.postedAt })
    .from(document)
    .where(
      and(
        eq(document.refCustomerBillId, customerBillId),
        eq(document.periodPartition, periodPartition),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function readCustomer(
  tx: Database,
  refPartyRoleId: string,
): Promise<{
  name: string;
  tradingName: string | null;
  registrationNumber: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  address: InvoiceAddress | null;
}> {
  const [org] = await tx
    .select({
      name: organization.name,
      tradingName: organization.tradingName,
      registrationNumber: organization.registrationNumber,
      taxId: organization.taxId,
      preferredContactMediumId: partyRole.contactMedium,
    })
    .from(partyRole)
    .innerJoin(
      organization,
      eq(organization.organizationId, partyRole.engagedParty),
    )
    .where(eq(partyRole.partyRoleId, refPartyRoleId))
    .limit(1);
  if (!org) {
    throw new Error(
      `invoiceRenderInputRepository: no organization for party role ${refPartyRoleId}`,
    );
  }

  const contactSelect = {
    emailAddress: contactMedium.emailAddress,
    phoneNumber: contactMedium.phoneNumber,
    gaAddressLine1: contactMedium.gaAddressLine1,
    gaAddressLine2: contactMedium.gaAddressLine2,
    gaCity: contactMedium.gaCity,
    gaStateProvince: contactMedium.gaStateProvince,
    gaPostalCode: contactMedium.gaPostalCode,
    gaCountry: contactMedium.gaCountry,
  };

  interface ContactRow {
    emailAddress: string | null;
    phoneNumber: string | null;
    gaAddressLine1: string | null;
    gaAddressLine2: string | null;
    gaCity: string | null;
    gaStateProvince: string | null;
    gaPostalCode: string | null;
    gaCountry: string | null;
  }

  let contact: ContactRow | undefined;
  if (org.preferredContactMediumId) {
    [contact] = await tx
      .select(contactSelect)
      .from(contactMedium)
      .where(eq(contactMedium.contactMediumId, org.preferredContactMediumId))
      .limit(1);
  }
  if (!contact) {
    [contact] = await tx
      .select(contactSelect)
      .from(contactMedium)
      .where(eq(contactMedium.refPartyRole, refPartyRoleId))
      .orderBy(asc(contactMedium.contactMediumId))
      .limit(1);
  }

  const address: InvoiceAddress | null =
    contact?.gaAddressLine1 != null
      ? {
          line1: contact.gaAddressLine1,
          line2: contact.gaAddressLine2,
          city: contact.gaCity,
          stateProvince: contact.gaStateProvince,
          postalCode: contact.gaPostalCode,
          country: contact.gaCountry,
        }
      : null;

  return {
    name: org.name,
    tradingName: org.tradingName,
    registrationNumber: org.registrationNumber,
    taxId: org.taxId,
    email: contact?.emailAddress ?? null,
    phone: contact?.phoneNumber ?? null,
    address,
  };
}

export const invoiceRenderInputRepository = {
  // bm53-spec §Design D5 step 1 — the bill's three version stamps (all `null`
  // until bm54 stamps them at posting), read in the binder's own repeatable-
  // read transaction BEFORE `read()`: resolution needs them, and the resolved
  // structure decides whether `read()` includes the usage section. `null` when
  // no bill exists for the run/account.
  async readBillStamps(
    tx: Database,
    { runId, banId }: { runId: string; banId: string },
  ): Promise<PostedBillStamps | null> {
    const [row] = await tx
      .select({
        refBillTemplateVersionId: customerBill.refBillTemplateVersionId,
        refInvoiceProfileVersion: customerBill.refInvoiceProfileVersion,
        refCsvTemplateVersionId: customerBill.refCsvTemplateVersionId,
      })
      .from(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, runId),
          eq(customerBill.refBillingAccountId, banId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // bm49-spec §Implementation §2 — `includeUsage` (D4) and `timezone` thread
  // through to the usage read. When `includeUsage` is false the annex section
  // is hidden, so the usage read AND the over-limit/reconcile checks are
  // skipped and `usage` is `null` (a hidden annex must not park an account for
  // a section it doesn't print). The usage read is delegated to
  // `ratedLinesRepository` (its R9 home) so this file keeps no rating-schema
  // reference; it runs under the same transaction the binder opened.
  async read(
    tx: Database,
    {
      runId,
      banId,
      timezone,
      includeUsage,
    }: {
      runId: string;
      banId: string;
      timezone: string;
      includeUsage: boolean;
    },
  ): Promise<RawInvoiceRenderInput | null> {
    const header = await readBillHeader(tx, runId, banId);
    if (!header) return null;

    const [lineData, taxItems, doc, customer, usage] = await Promise.all([
      readLines(tx, header.customerBillId, header.periodPartition),
      customerBillTaxItemRepository.listForBill(
        tx,
        header.customerBillId,
        header.periodPartition,
      ),
      readDocument(tx, header.customerBillId, header.periodPartition),
      readCustomer(tx, header.refPartyRoleId),
      includeUsage
        ? ratedLinesRepository.listBilledUsageForInvoice(tx, {
            runId,
            banId,
            attempt: header.attempt,
            timezone,
            limit: INVOICE_USAGE_ROW_LIMIT,
          })
        : Promise.resolve(null),
    ]);

    return {
      bill: {
        customerBillId: header.customerBillId,
        periodPartition: header.periodPartition,
        billingAccountId: header.billingAccountId,
        currency: header.currency,
        billingPeriodStart: header.billingPeriodStart,
        billingPeriodEnd: header.billingPeriodEnd,
        paymentDueDate: header.paymentDueDate,
        subtotal: header.subtotal,
        taxTotal: header.taxTotal,
        totalAmount: header.totalAmount,
        linesNetSum: lineData.linesNetSum,
        grossTotal: lineData.grossTotal,
        discountTotal: lineData.discountTotal,
        usageRatedTotal: lineData.usageRatedTotal,
      },
      run: { billRunId: header.billRunId, cycleName: header.cycleName },
      lines: lineData.lines,
      taxItems,
      document: doc,
      customer,
      usage,
    };
  },
};
