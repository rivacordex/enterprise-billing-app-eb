import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// bm49-spec §Implementation §5 / Inv #47 — the render path reads the usage
// annex geo off `rating.udr_rated.state/district` (delegated to
// `rated-lines.repository.ts`), and NEVER from the bm45 `additional_info`
// snapshot or a ratecard query. This guardrail freezes that boundary:
//
//   1. `invoice-render-input.ts` (the binder's only repository) carries no
//      `rating.` reference — the usage read goes through `ratedLinesRepository`.
//   2. No file under `services/billing/invoice-template/**` or
//      `render-invoice*.ts` references `additional_info` or
//      `ratecard_ran_usage_lkp`.
describe("invoice render source boundary (bm49-spec §Implementation §5, Inv #47)", () => {
  it("invoice-render-input.ts contains no `rating.` reference", () => {
    const source = readFileSync(
      resolve(process.cwd(), "db/repositories/billing/invoice-render-input.ts"),
      "utf8",
    );
    // A schema-qualified rating reference or a rating-schema import would both
    // breach the boundary; the usage read is delegated to a billing repository
    // instead.
    expect(source).not.toMatch(/\brating\./);
    expect(source).not.toMatch(/@\/db\/schema\/rating/);
  });

  it("no render-template or render-invoice file reads additional_info or ratecard_ran_usage_lkp", () => {
    const renderPathFiles: string[] = [];

    const templateDir = resolve(
      process.cwd(),
      "services/billing/invoice-template",
    );
    for (const f of readdirSync(templateDir)) {
      if (f.endsWith(".ts") && !f.endsWith(".test.ts")) {
        renderPathFiles.push(resolve(templateDir, f));
      }
    }

    const billingDir = resolve(process.cwd(), "services/billing");
    for (const f of readdirSync(billingDir)) {
      if (/^render-invoice.*\.ts$/.test(f) && !f.endsWith(".test.ts")) {
        renderPathFiles.push(resolve(billingDir, f));
      }
    }

    const offenders: string[] = [];
    for (const file of renderPathFiles) {
      const source = readFileSync(file, "utf8");
      if (/additional_info|ratecard_ran_usage_lkp/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
