import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// bm16-spec §Design "Phase-1 app-side compute retired (Fork B)" /
// §Implementation §5 / Verification checklist. Phase 2 moves Validation,
// Collection, Aggregation, Taxation, and Verification off the app and onto
// the bill run processor, which writes the bill-data itself (as
// `billrun_runtime`, bm14). A second app-side writer of the SAME trial data
// would violate the two-writer grant boundary (architecture Inv. #2), so
// this guardrail asserts structurally that no app code path can still
// compute or write a trial `customer_bill`/`customer_bill_tax_item` — the
// ONLY remaining app-side `customer_bill` write is the posting stamp
// (`stampPosted`, `post-run.ts`), which app_runtime keeps (bm14 §Implementation,
// "narrow nothing on app_runtime — it keeps its customer_bill grant for the
// posting stamps, bm19").
describe("no app service re-derives customer_bill/customer_bill_tax_item (bm16-spec Fork B)", () => {
  const SERVICES_DIR = resolve(process.cwd(), "services/billing");

  it("the retired phase-1 compute services no longer exist", () => {
    for (const file of [
      "validate-account.ts",
      "aggregate-bill.ts",
      "taxation.ts",
      "verify.ts",
      "collect-claim.ts",
    ]) {
      expect(existsSync(resolve(SERVICES_DIR, file))).toBe(false);
    }
  });

  it("customer-bill.repository.ts no longer exports a trial-bill write (insertTrial/deleteTrial)", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "db/repositories/billing/customer-bill.repository.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\basync insertTrial\(/);
    expect(source).not.toMatch(/\basync deleteTrial\(/);
  });

  it("customer-bill-tax-item.repository.ts no longer exports a tax-item write (replaceForBill)", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "db/repositories/billing/customer-bill-tax-item.repository.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\basync replaceForBill\(/);
  });

  it("only post-run.ts calls customerBillRepository.stampPosted — the sole remaining app-side customer_bill write (the posting stamp)", () => {
    const files = readdirSync(SERVICES_DIR).filter((f) => f.endsWith(".ts"));
    const callers = files.filter((f) => {
      const source = readFileSync(resolve(SERVICES_DIR, f), "utf8");
      return /\.stampPosted\(/.test(source);
    });
    expect(callers).toEqual(["post-run.ts"]);
  });

  it("handle-stage-signal.ts triggers no write side effect for any stage — it only inserts the stage row and advances the account", () => {
    const source = readFileSync(
      resolve(SERVICES_DIR, "handle-stage-signal.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/customerBillRepository|customerBillTaxItemRepository/);
  });
});
