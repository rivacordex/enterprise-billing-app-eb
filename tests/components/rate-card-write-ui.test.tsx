import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  RATE_CARD_DIFF_BADGE_VARIANTS,
  RATE_CARD_DIFF_CATEGORIES,
  RateCardDiffBadge,
} from "@/components/products/rate-card/rate-card-diff-badge";
import { RateCardDiffPanel } from "@/components/products/rate-card/rate-card-diff-panel";
import { UploadErrorTable } from "@/components/products/rate-card/upload-error-table";
import type { RatecardRanUsageLkp } from "@/db/schema/product";
import type { RateCardIssue } from "@/validation/product/ratecard.schema";

function makeRow(
  overrides: Partial<RatecardRanUsageLkp> = {},
): RatecardRanUsageLkp {
  return {
    ratecardRanUsageLkpId: "01J000000000000000000000A0",
    ratecardVersionId: "RCV00000001",
    mnoPublicKey: "MNO-1",
    commercialUnitPublicKey: "CU-1",
    polygonId: "PLY-1",
    polygonStartDate: "2026-09-30",
    polygonEndDate: null,
    state: "Selangor",
    district: "Petaling",
    lkpSubscriberRefId: "PRDINV00000001",
    serviceCode: "SVC-1",
    ratePerUnit: "0.050000",
    ...overrides,
  };
}

describe("RateCardDiffBadge (D5, test 6)", () => {
  it("has a total record over the three categories, each with a distinct hue AND icon", () => {
    expect([...RATE_CARD_DIFF_CATEGORIES]).toEqual([
      "added",
      "changed",
      "removed",
    ]);

    const classNames = RATE_CARD_DIFF_CATEGORIES.map(
      (c) => RATE_CARD_DIFF_BADGE_VARIANTS[c].className,
    );
    // Distinct hues: success / info / danger.
    expect(new Set(classNames).size).toBe(3);
    expect(RATE_CARD_DIFF_BADGE_VARIANTS.added.className).toContain("success");
    expect(RATE_CARD_DIFF_BADGE_VARIANTS.changed.className).toContain("info");
    expect(RATE_CARD_DIFF_BADGE_VARIANTS.removed.className).toContain("danger");

    // Distinct icons.
    const icons = RATE_CARD_DIFF_CATEGORIES.map(
      (c) => RATE_CARD_DIFF_BADGE_VARIANTS[c].icon,
    );
    expect(new Set(icons).size).toBe(3);
  });

  it("renders label + icon, and 'Removed' is never 'Deleted'/'Retiring'", () => {
    render(<RateCardDiffBadge category="removed" />);
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.queryByText(/Deleted|Retiring/)).not.toBeInTheDocument();
  });
});

describe("RateCardDiffPanel (D5, tests 6/7)", () => {
  const diff = {
    added: {
      count: 1,
      rows: [
        {
          mnoPublicKey: "MNO-A",
          commercialUnitPublicKey: "CU-A",
          polygonId: "PLY-A",
          incoming: makeRow({ polygonId: "PLY-A" }),
        },
      ],
    },
    changed: {
      count: 1,
      rows: [
        {
          mnoPublicKey: "MNO-B",
          commercialUnitPublicKey: "CU-B",
          polygonId: "PLY-B",
          outgoing: makeRow({ polygonId: "PLY-B", serviceCode: "OLD-SVC" }),
          incoming: makeRow({ polygonId: "PLY-B", serviceCode: "NEW-SVC" }),
        },
      ],
    },
    removed: {
      count: 1,
      rows: [
        {
          mnoPublicKey: "MNO-C",
          commercialUnitPublicKey: "CU-C",
          polygonId: "PLY-C",
          outgoing: makeRow({ polygonId: "PLY-C" }),
        },
      ],
    },
  };

  it("renders three buckets each headed by its count, changed cells show old→new, removed names the superseded version", () => {
    render(
      <RateCardDiffPanel diff={diff} currentActiveVersionId="RCV00000002" />,
    );

    // All three badges render (in one view).
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();

    // Changed cell shows both states.
    expect(screen.getByText("OLD-SVC")).toBeInTheDocument();
    expect(screen.getByText("NEW-SVC")).toBeInTheDocument();

    // Removed names the version that still holds the key.
    expect(screen.getByText("RCV00000002")).toBeInTheDocument();
  });

  it("uses the word 'Removed' and never 'Retiring' or 'carried forward' in the rendered output", () => {
    const { container } = render(
      <RateCardDiffPanel diff={diff} currentActiveVersionId="RCV00000002" />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Removed");
    expect(text).not.toMatch(/Retiring/i);
    expect(text).not.toMatch(/carried forward/i);
    expect(text).not.toMatch(/Deleted/i);
  });
});

describe("UploadErrorTable (D4, tests 4/5)", () => {
  const issues: RateCardIssue[] = [
    {
      violation: "HEADER_MISMATCH",
      line: 1,
      column: "Date",
      value: "Date",
      reason: 'Unknown column "Date" — the header does not match the contract.',
    },
    {
      violation: "ROW_SCHEMA_INVALID",
      line: 2,
      column: "polygon_start_date",
      value: "2026-13-01",
      reason: "Must be a real calendar date in YYYY-MM-DD format.",
    },
  ];

  it("renders Line · Column · Value · Reason, quoting the validator verbatim", () => {
    render(<UploadErrorTable issues={issues} />);

    for (const header of ["Line", "Column", "Value", "Reason"]) {
      expect(screen.getByText(header)).toBeInTheDocument();
    }
    // Reason is verbatim, not paraphrased.
    expect(
      screen.getByText("Must be a real calendar date in YYYY-MM-DD format."),
    ).toBeInTheDocument();
    // A HEADER_MISMATCH row names the offending column exactly as spelled.
    expect(
      screen.getByText(
        'Unknown column "Date" — the header does not match the contract.',
      ),
    ).toBeInTheDocument();
  });

  it("renders line numbers exactly as returned — the first data row is 2 (test 5)", () => {
    render(<UploadErrorTable issues={issues} />);
    const table = screen.getByRole("table");
    // Header line 1 and first-data-row line 2 both appear as returned.
    expect(within(table).getByText("1")).toBeInTheDocument();
    expect(within(table).getByText("2")).toBeInTheDocument();
  });

  it("shows the 'No version was created' banner (not a toast, not a paraphrase)", () => {
    render(<UploadErrorTable issues={issues} />);
    expect(
      screen.getByText(
        "No version was created. Fix the file and upload again.",
      ),
    ).toBeInTheDocument();
  });
});
