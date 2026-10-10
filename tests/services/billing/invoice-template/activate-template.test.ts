import { describe, expect, it, vi } from "vitest";

// bm58 review fixes: the activation test-render must also execute against the
// typed `PROBE_RENDER_INPUT` that `loadGenerated` runs at first load, so a
// template cannot pass activation and then fail the load probe once it is
// already ACTIVE. Real compile/execute path; only the DB and blob edges mocked.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: {},
}));
vi.mock("@/services/billing/blob-store", () => ({ blobStore: {} }));

import { readFileSync } from "node:fs";
import path from "node:path";

import { testRender } from "@/services/billing/invoice-template/activate-template";
import { PROBE_RENDER_INPUT } from "@/services/billing/invoice-template/load";
import type { InvoiceRenderInput } from "@/types/billing";

const SEEDED = path.join(
  process.cwd(),
  "db/seeds/invoice-templates/generated/INVOICE/v1",
);
const INVOICE = readFileSync(path.join(SEEDED, "invoice.hbs"), "utf-8");
const FOOTER = readFileSync(path.join(SEEDED, "footer.hbs"), "utf-8");
const SAMPLE = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      "db/seeds/invoice-templates/INVTPL-STD-A4/v1/sample-data.json",
    ),
    "utf-8",
  ),
) as InvoiceRenderInput;

describe("testRender", () => {
  it("passes the seeded default template", () => {
    expect(() => testRender(INVOICE, FOOTER, SAMPLE)).not.toThrow();
  });

  it("[CRITICAL] fails a template that the sample bill satisfies but the load-time probe does not", () => {
    // `company.tradingName` is in the layout's sample-data.json but not in the
    // typed probe input; under Handlebars strict mode only the probe throws.
    expect(
      (SAMPLE.company as unknown as Record<string, unknown>).tradingName,
    ).toBeDefined();
    expect(
      (PROBE_RENDER_INPUT.company as unknown as Record<string, unknown>)
        .tradingName,
    ).toBeUndefined();

    const badInvoice = `${INVOICE}\n{{#if company}}{{company.tradingName}}{{/if}}`;
    expect(() => testRender(badInvoice, FOOTER, SAMPLE)).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_COMPILE_FAILED" }),
    );
  });

  it("fails a template that references an unknown helper", () => {
    expect(() =>
      testRender(`${INVOICE}{{bogusHelper invoice.number}}`, FOOTER, SAMPLE),
    ).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_COMPILE_FAILED" }),
    );
  });

  it("fails a footer without the page-number spans", () => {
    expect(() =>
      testRender(INVOICE, "<div>no page numbers</div>", SAMPLE),
    ).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_COMPILE_FAILED" }),
    );
  });

  it("fails an output that still carries a [[ ]] directive", () => {
    expect(() =>
      testRender(`${INVOICE}\n[[if sections.notes]]`, FOOTER, SAMPLE),
    ).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_COMPILE_FAILED" }),
    );
  });
});
