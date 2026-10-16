import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import type { InvoiceRenderInput } from "@/types/billing";

// Shared DB-free render-input fixtures, so each suite states only what it
// changes (Sonar duplication: bm70 widened every suite's own copy). Each call
// returns a fresh object; spread a field to change part of it.

type RawLine = RawInvoiceRenderInput["lines"][number];

const RECURRING_LINE: RawLine = {
  lineNo: 1,
  source: "RECURRING",
  lineType: "charge",
  description: "Enterprise Fibre 1Gbps",
  refProductOfferingId: "POF00000010",
  udrType: null,
  udrCount: null,
  quantity: "1.000000",
  unit: "EA",
  snapshotQuantity: "1.000000",
  snapshotUnitPrice: "50.00",
  grossAmount: "50.00",
  discountAmount: "0.00",
  netAmount: "50.00",
  discountRate: null,
  groupGrossTotal: "50.00",
  groupDiscountTotal: "0.00",
  groupNetTotal: "50.00",
};

const USAGE_LINE: RawLine = {
  lineNo: 2,
  source: "USAGE",
  lineType: "charge",
  description: "RAN Usage",
  refProductOfferingId: "POF00000020",
  udrType: "RAN_USAGE",
  udrCount: 2,
  quantity: "100.000000",
  unit: "GB",
  snapshotQuantity: null,
  snapshotUnitPrice: null,
  grossAmount: "120.00",
  discountAmount: "20.00",
  netAmount: "100.00",
  discountRate: "16.666667",
  groupGrossTotal: "120.00",
  groupDiscountTotal: "20.00",
  groupNetTotal: "100.00",
};

// A customer with every optional field null.
export const BARE_RAW_CUSTOMER: RawInvoiceRenderInput["customer"] = {
  recipientName: null,
  name: "Acme Communications Sdn Bhd",
  tradingName: null,
  registrationNumber: null,
  taxId: null,
  email: null,
  phone: null,
  address: null,
};

// The repository's raw read: a RECURRING RM50 line and a discounted USAGE
// RM100 line, both non-capacity charges (no `:CAPACITY:` key), on a fully
// populated customer.
export function rawInvoiceRenderInputFixture(
  overrides: Partial<RawInvoiceRenderInput> = {},
): RawInvoiceRenderInput {
  return {
    bill: {
      customerBillId: "CBL00000001",
      periodPartition: "2026-08-01",
      billingAccountId: "BAN00000001",
      currency: "MYR",
      billingPeriodStart: "2026-08-01",
      billingPeriodEnd: "2026-08-31",
      paymentDueDate: "2026-09-15",
      subtotal: "150.00",
      taxTotal: "0.00",
      totalAmount: "150.00",
      linesNetSum: "150.00",
      grossTotal: "150.00",
      discountTotal: "0.00",
      usageRatedTotal: "0.00",
      otherChargesSubTotal: "150.00",
      adjustments: "0.00",
      summaryBlocksSum: "150.00",
    },
    run: { billRunId: "BRN00000042", cycleName: "Enterprise Monthly" },
    lines: [{ ...RECURRING_LINE }, { ...USAGE_LINE }],
    serviceTypes: [],
    otherCharges: [
      { description: "Enterprise Fibre 1Gbps", amount: "50.00" },
      { description: "RAN Usage", amount: "100.00" },
    ],
    taxItems: [],
    document: null,
    customer: {
      recipientName: "Aisha Rahman",
      name: "Acme Communications Sdn Bhd",
      tradingName: "Acme Communications",
      registrationNumber: "201001098765",
      taxId: "C98765432109",
      email: "accounts@acme.example",
      phone: "+60 3-7654 3210",
      address: {
        line1: "Suite 5, Wisma Acme",
        line2: null,
        city: "City-01",
        stateProvince: "State-01",
        postalCode: "46050",
        country: "Country-01",
      },
    },
    usage: null,
    ...overrides,
  };
}

// The bound render input: a final RM100 invoice with no lines, no profile and
// no company.
export function invoiceRenderInputFixture(
  overrides: Partial<InvoiceRenderInput> = {},
): InvoiceRenderInput {
  return {
    template: { layoutCode: "INVTPL-STD-A4", layoutVersion: 1, version: 1 },
    company: null,
    payment: null,
    invoice: {
      number: "INV00000001",
      isDraft: false,
      date: "2026-09-05",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      dueDate: "2026-09-15",
      paymentTermsDays: null,
      currency: "MYR",
      billRunId: "BRN00000042",
      cycleName: "Enterprise Monthly",
      billRef: "CBL00000001",
      poRef: null,
      contractRef: null,
    },
    customer: {
      billingAccountId: "BAN00000001",
      recipientName: null,
      name: "Acme",
      tradingName: null,
      registrationNo: null,
      tin: null,
      sstRegNo: null,
      address: null,
      email: null,
      phone: null,
    },
    totals: {
      grossTotal: "100.00",
      discountTotal: "0.00",
      subtotalExclTax: "100.00",
      taxTotal: "0.00",
      totalAmount: "100.00",
      amountDue: "100.00",
      totalCharges: "100.00",
      adjustments: "0.00",
      otherChargesSubTotal: "0.00",
    },
    taxes: [],
    taxRateLabel: "0",
    serviceTypes: [],
    otherCharges: [],
    lineGroups: [],
    usage: null,
    isDraft: false,
    locale: "en-MY",
    timezone: "UTC",
    ...overrides,
  };
}
