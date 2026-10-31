// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  delivered,
  download,
  type Execution,
  expectNothingPublished,
  kestraConfigured,
  klDate,
  label,
  messages,
  published,
  putNamespaceFile,
  ran,
  runFlow,
  sha256,
} from "@/tests/helpers/reporting-kestra-live";

// rpt03-spec Tests T17, T19 and the WARNING path — `report-settlement-invoice`
// end to end on a live engine, with the `reporting` flows and contracts
// deployed, and the engine's REPORTING_DB_* pointing at a database seeded
// with the Part A fixture (tests/fixtures/reporting/settlement-seed.ts).
// Skipped unless the engine's URL and Basic Auth credential are set (the same
// variables as rpt02's live suite):
//
//   KESTRA_URL=http://localhost:8085
//   KESTRA_BASIC_AUTH_USER=… KESTRA_BASIC_AUTH_PASSWORD=…
//
// T19 uploads a deliberately wrong contracts/settlement_invoice.yaml for one
// run and restores the committed one afterwards.

const CONTRACT = join(
  process.cwd(),
  "workflow-management/flows/reporting/contracts/settlement_invoice.yaml",
);
const FLOW_ID = "report-settlement-invoice";
const INVOICE_HEADER =
  "mno_id,invoice_entry_date,invoice_id,invoice_amount,invoice_due_date,invoice_open_amount";
const PAYMENT_HEADER =
  "mno_id,payment_transaction_no,type_of_payment,payment_amount,invoice_id,payment_reference,cheque_realization_date,comment";

const run = (inputs: Record<string, string>): Promise<Execution> =>
  runFlow(FLOW_ID, inputs);

const putContract = (content: string) =>
  putNamespaceFile("/contracts/settlement_invoice.yaml", content);

describe.skipIf(!kestraConfigured)(
  "rpt03 report-settlement-invoice on a live engine",
  { timeout: 180_000 },
  () => {
    it("WARNING path: a skipped invoice ends WARNING, publishes both files with one DELIVERED line each, and labels the run", async () => {
      const e = await run({ billing_period: "202609" });
      expect(e.state.current).toBe("WARNING");
      expect(await messages(e, "WARN")).toContainEqual(
        expect.stringMatching(/^SKIPPED INV\d{8} MNO_PUBLIC_KEY_MISSING$/),
      );
      expect(label(e, "report")).toBe("settlement_invoice");
      expect(label(e, "billing_period")).toBe("202609");
      expect(label(e, "as_of_date")).toBe(klDate()); // the effective default
      expect(label(e, "skipped_invoices")).toBe("1");
      expect(label(e, "flow_revision")).toMatch(/^\d+$/);

      const files = published(e);
      const names = Object.keys(files).sort();
      expect(names).toHaveLength(2);
      const [invoiceName, paymentName] = names as [string, string];
      expect(invoiceName).toMatch(
        /^Reporting_dnb_settlement_invoice_\d{14}\.csv$/,
      );
      expect(paymentName).toMatch(
        /^Reporting_dnb_settlement_invoice_payment_\d{14}\.csv$/,
      );
      const invoiceUri = files[invoiceName]!;
      const paymentUri = files[paymentName]!;
      // One <ts> for both files (SR22).
      expect(paymentName.replace("_payment", "")).toBe(invoiceName);
      const invoice = await download(e, invoiceUri);
      const payment = await download(e, paymentUri);
      expect(invoice.split("\n")[0]).toBe(INVOICE_HEADER);
      expect(payment.split("\n")[0]).toBe(PAYMENT_HEADER);

      const rev = label(e, "flow_revision");
      // Logged in argument order, but both in the same millisecond, so the
      // logs API may return either first.
      expect((await delivered(e)).sort()).toEqual([
        `DELIVERED ${invoiceName} sha256=${sha256(invoice)} rev=${rev}`,
        `DELIVERED ${paymentName} sha256=${sha256(payment)} rev=${rev}`,
      ]);
    });

    it("a clean period ends SUCCESS with skipped_invoices=0", async () => {
      const e = await run({ billing_period: "202606", as_of_date: "20260731" });
      expect(e.state.current).toBe("SUCCESS");
      expect(label(e, "skipped_invoices")).toBe("0");
      expect(Object.keys(published(e))).toHaveLength(2);
    });

    describe("T17 — bad inputs fail at validate_period with the SR25 code; nothing runs after it", () => {
      for (const [inputs, code] of [
        [{ billing_period: "202613" }, "INVALID_BILLING_PERIOD 202613"],
        [
          { billing_period: "202609", as_of_date: "20261332" },
          "INVALID_AS_OF_DATE 20261332",
        ],
        [
          { billing_period: "202609", as_of_date: klDate(1) },
          `INVALID_AS_OF_DATE ${klDate(1)}`,
        ],
        [
          { billing_period: "202609", as_of_date: "20260815" },
          "INVALID_AS_OF_DATE 20260815",
        ],
      ] as const) {
        it(`${JSON.stringify(inputs)} → FAILED ${code}`, async () => {
          const e = await run(inputs);
          expect(e.state.current).toBe("FAILED");
          expect(await messages(e, "ERROR")).toContain(code);
          expect(ran(e, "generate")).toBe(false);
          await expectNothingPublished(e);
        });
      }
    });

    it("T15 (flow) — an empty past period fails NO_INVOICES_FOR_PERIOD; nothing published", async () => {
      const e = await run({ billing_period: "202501" });
      expect(e.state.current).toBe("FAILED");
      expect(await messages(e, "ERROR")).toContain(
        "NO_INVOICES_FOR_PERIOD 202501",
      );
      await expectNothingPublished(e);
    });

    it("T19 — a generated file that fails its column definition stops publish: FAILED OUTPUT_CONTRACT_VIOLATION, no outputs", async () => {
      const committed = readFileSync(CONTRACT, "utf8");
      // The runtime still writes 2 dp amounts; the contract now wants an
      // integer, so the output check (not the writer) must catch it.
      const wrong = committed.replace(
        /(- name: invoice_open_amount\n\s+type:) amount/,
        "$1 integer",
      );
      expect(wrong).not.toBe(committed);
      await putContract(wrong);
      try {
        const e = await run({
          billing_period: "202606",
          as_of_date: "20260731",
        });
        expect(e.state.current).toBe("FAILED");
        expect(await messages(e, "ERROR")).toContainEqual(
          expect.stringMatching(
            /^OUTPUT_CONTRACT_VIOLATION Reporting_dnb_settlement_invoice_\d{14}\.csv 2 invoice_open_amount BAD_INTEGER$/,
          ),
        );
        expect(ran(e, "validate_output_payment")).toBe(false);
        await expectNothingPublished(e);
      } finally {
        await putContract(committed);
      }
    });
  },
);
