import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  staticComplianceProblems,
  visibleComplianceProblems,
} from "@/services/billing/invoice-template/compliance";
import { readSectionsVisibly } from "@/services/billing/invoice-template/compliance-render";
import { layoutFilesFromVerified } from "@/services/billing/invoice-template/generate";

// bm76-spec §6 / code-standards guardrail item 72, VISIBLE tier (Inv #63) — a
// REAL Chromium read through bm75's hardened context (`withHardenedPage`):
// each required value must appear in its section's `innerText` and be legible
// (opacity ≥ 0.1, font-size ≥ 6px). Gated like the other Chromium e2e suites:
//
//   RUN_CHROMIUM_E2E=1 node --env-file=.env node_modules/vitest/vitest.mjs run \
//     tests/services/billing/invoice-template/compliance-visible.e2e.test.ts
//
// Each hiding trick passes the static tier and fails this one, which proves
// the visible tier adds coverage the HTML check cannot.
const run = process.env.RUN_CHROMIUM_E2E === "1";

const SEED_ROOT = path.join(process.cwd(), "db/seeds/invoice-templates");
const TIN_LINE = '<div class="mono">TIN {{company.tin}}</div>';

function packageFiles(dir: string): Map<string, Buffer> {
  const root = path.join(SEED_ROOT, dir);
  const out = new Map<string, Buffer>();
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      const child = path.join(abs, entry);
      if (statSync(child).isDirectory()) walk(child);
      else
        out.set(
          path.relative(root, child).split(path.sep).join("/"),
          readFileSync(child),
        );
    }
  };
  walk(root);
  return out;
}

function standardWithTinLine(replacement: string): Map<string, Buffer> {
  const files = packageFiles("INVTPL-STD-A4/v1");
  const header = files.get("partials/header.hbs")!.toString("utf8");
  expect(header).toContain(TIN_LINE);
  files.set(
    "partials/header.hbs",
    Buffer.from(header.replace(TIN_LINE, replacement)),
  );
  return files;
}

describe.skipIf(!run)(
  "guardrail 72 (visible tier) — real Chromium (RUN_CHROMIUM_E2E=1)",
  () => {
    it.each([["INVTPL-STD-A4/v1"], ["INVTPL-BASIC-A4/v1"]])(
      "%s is visibly compliant",
      async (dir) => {
        const staticResult = staticComplianceProblems(
          layoutFilesFromVerified(packageFiles(dir)),
        );
        expect(staticResult.problems).toEqual([]);
        expect(
          await visibleComplianceProblems(
            staticResult.html,
            readSectionsVisibly,
          ),
        ).toEqual([]);
      },
      60_000,
    );

    it.each([
      [
        "display:none",
        '<div class="mono" style="display:none">TIN {{company.tin}}</div>',
        "does not visibly print",
      ],
      [
        "the hidden attribute",
        '<div class="mono" hidden>TIN {{company.tin}}</div>',
        "does not visibly print",
      ],
      [
        "visibility:hidden",
        '<div class="mono" style="visibility:hidden">TIN {{company.tin}}</div>',
        "does not visibly print",
      ],
      [
        "opacity:0",
        '<div class="mono" style="opacity:0">TIN {{company.tin}}</div>',
        "illegibly",
      ],
      [
        "font-size:1px",
        '<div class="mono" style="font-size:1px">TIN {{company.tin}}</div>',
        "illegibly",
      ],
    ])(
      "the header TIN hidden by %s passes the static tier and fails the visible tier",
      async (_trick, line, expected) => {
        const staticResult = staticComplianceProblems(
          layoutFilesFromVerified(standardWithTinLine(line)),
        );
        expect(staticResult.problems).toEqual([]);

        const problems = await visibleComplianceProblems(
          staticResult.html,
          readSectionsVisibly,
        );
        expect(problems).toContainEqual({
          file: "(render)",
          code: "LAYOUT_MISSING_REQUIRED_BLOCKS",
          message: expect.stringMatching(
            new RegExp(
              `^section header (?=.*${expected})(?=.*the supplier TIN)`,
            ),
          ),
        });
      },
      60_000,
    );

    // Code review fixes (2026-10-25) — each was reproduced against the first
    // reader; each now fails (or, for the last two, passes) as it should.
    async function visibleOf(files: Map<string, Buffer>) {
      const staticResult = staticComplianceProblems(
        layoutFilesFromVerified(files),
      );
      expect(staticResult.problems).toEqual([]);
      return visibleComplianceProblems(
        staticResult.renders,
        readSectionsVisibly,
      );
    }

    function standardWithShell(from: string, to: string): Map<string, Buffer> {
      const files = packageFiles("INVTPL-STD-A4/v1");
      const shell = files.get("shell.hbs")!.toString("utf8");
      expect(shell).toContain(from);
      files.set("shell.hbs", Buffer.from(shell.replace(from, to)));
      return files;
    }

    const TIN_PROBLEM = expect.objectContaining({
      message: expect.stringMatching(/^section header .*the supplier TIN/),
    });

    it("a hidden copy of the TIN cannot vouch for an opacity:0 copy", async () => {
      const problems = await visibleOf(
        standardWithTinLine(
          '<div hidden>{{company.tin}}</div><div style="opacity:0">TIN {{company.tin}}</div>',
        ),
      );
      expect(problems).toContainEqual(TIN_PROBLEM);
    }, 60_000);

    it("an off-screen .sec--header decoy is not read in place of the real section", async () => {
      const files = standardWithShell(
        '<div class="sheet">',
        '<div class="sec--header" style="position:absolute;left:-9999px">{{company.name}} {{company.registrationNo}} {{company.tin}} {{company.sstRegNo}} {{company.addressLine1}}</div>\n  <div class="sheet">',
      );
      const header = files.get("partials/header.hbs")!.toString("utf8");
      files.set(
        "partials/header.hbs",
        Buffer.from(
          header.replace(
            TIN_LINE,
            '<div class="mono" style="display:none">TIN {{company.tin}}</div>',
          ),
        ),
      );
      expect(await visibleOf(files)).toContainEqual(TIN_PROBLEM);
    }, 60_000);

    it("CSS that hides the TIN only when Payment is hidden fails", async () => {
      const files = standardWithShell(
        "</style>",
        "  .tin { display: none; }\n  [[if sections.payment]].tin { display: block; }[[/if]]\n</style>",
      );
      const header = files.get("partials/header.hbs")!.toString("utf8");
      files.set(
        "partials/header.hbs",
        Buffer.from(
          header.replace(
            TIN_LINE,
            '<div class="tin">TIN {{company.tin}}</div>',
          ),
        ),
      );
      expect(await visibleOf(files)).toContainEqual(
        expect.objectContaining({
          message: expect.stringMatching(
            /^section header .*the supplier TIN.*\(with Payment hidden\)$/,
          ),
        }),
      );
    }, 60_000);

    it("stacked opacity is multiplied (three nested 0.3 = 0.027)", async () => {
      const problems = await visibleOf(
        standardWithTinLine(
          '<div style="opacity:.3"><div style="opacity:.3"><div style="opacity:.3">TIN {{company.tin}}</div></div></div>',
        ),
      );
      expect(problems).toContainEqual(TIN_PROBLEM);
    }, 60_000);

    it("a near-transparent .sheet in the shell makes every required value illegible", async () => {
      const problems = await visibleOf(
        standardWithShell(
          '<div class="sheet">',
          '<div class="sheet" style="opacity:0.02">',
        ),
      );
      expect(problems).toContainEqual(TIN_PROBLEM);
      expect(problems).toContainEqual(
        expect.objectContaining({
          message: expect.stringMatching(/^section amountDue .*illegibly/),
        }),
      );
    }, 60_000);

    it("uppercase text-transform is not a false failure", async () => {
      const problems = await visibleOf(
        standardWithShell(
          "</style>",
          "  .supplier { text-transform: uppercase; }\n</style>",
        ),
      );
      expect(problems).toEqual([]);
    }, 60_000);

    it("a font-size:0 container with sized children is not a false failure", async () => {
      const problems = await visibleOf(
        standardWithTinLine(
          '<div style="font-size:0"><span style="font-size:12px">TIN {{company.tin}}</span></div>',
        ),
      );
      expect(problems).toEqual([]);
    }, 60_000);
  },
);
