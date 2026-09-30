import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// next/link → a plain anchor in jsdom (no App Router context needed).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: unknown;
    children: React.ReactNode;
  }) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

import { RateCardRowPreview } from "@/components/products/rate-card/rate-card-row-preview";
import {
  RATE_CARD_STATUS_BADGE_VARIANTS,
  RateCardStatusBadge,
} from "@/components/products/rate-card/rate-card-status-badge";
import { RateCardVersionTable } from "@/components/products/rate-card/rate-card-version-table";
import type { RatecardRanUsageLkp, RatecardVersion } from "@/db/schema/product";
import { RATE_CARD_VERSION_STATUSES } from "@/types/product";

function makeVersion(
  overrides: Partial<RatecardVersion> = {},
): RatecardVersion {
  return {
    ratecardVersionId: "RCV00000001",
    cardName: "RAN_USAGE",
    versionNum: 1,
    status: "ACTIVE",
    snapshotDate: "2026-09-30",
    sourceFile: "ran-usage.csv",
    fileChecksum: "a91f3c02",
    rowCount: 5400,
    uploadedBy: "user-1",
    uploadedAt: new Date("2026-09-30T02:00:00.000Z"),
    activatedBy: null,
    activatedAt: null,
    supersededByVersionId: null,
    rejectSummary: null,
    ...overrides,
  };
}

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

describe("RateCardStatusBadge (D2)", () => {
  it("has a total, closed variant record over the four statuses", () => {
    expect(Object.keys(RATE_CARD_STATUS_BADGE_VARIANTS).sort()).toEqual(
      [...RATE_CARD_VERSION_STATUSES].sort(),
    );
  });

  it("DRAFT takes the warning hue (not info) and SUPERSEDED is muted", () => {
    expect(RATE_CARD_STATUS_BADGE_VARIANTS.DRAFT.className).toContain(
      "warning",
    );
    expect(RATE_CARD_STATUS_BADGE_VARIANTS.DRAFT.className).not.toContain(
      "info",
    );
    expect(RATE_CARD_STATUS_BADGE_VARIANTS.SUPERSEDED.muted).toBe(true);
  });

  it("renders an icon + label, never colour-only", () => {
    render(<RateCardStatusBadge status="DRAFT" />);
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });
});

describe("RateCardVersionTable (D9)", () => {
  it("empty state reads 'No versions yet' and points at the upload button (test 11, empty state #1)", () => {
    render(
      <RateCardVersionTable
        versions={[]}
        selectedVersionId={null}
        locale="en-US"
        timezone="UTC"
      />,
    );
    expect(
      screen.getByText(
        "No versions yet. Upload a CSV to create the first one.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("One Active version per card")).toBeInTheDocument();
  });

  it("renders row_count and the snapshot date as ISO (test 9, test 10)", () => {
    render(
      <RateCardVersionTable
        versions={[makeVersion({ rowCount: 5400, snapshotDate: "2026-09-30" })]}
        selectedVersionId="RCV00000001"
        locale="en-US"
        timezone="UTC"
      />,
    );
    expect(screen.getByText("5400")).toBeInTheDocument();
    // ISO, not "30 Sep 2026".
    expect(screen.getByText("2026-09-30")).toBeInTheDocument();
    expect(screen.queryByText("30 Sep 2026")).not.toBeInTheDocument();
  });
});

describe("RateCardRowPreview (D9)", () => {
  it("renders rate_per_unit when present and a plain — when null (test 7)", () => {
    render(
      <RateCardRowPreview
        versionId="RCV00000001"
        rows={[
          makeRow({ polygonId: "PLY-1", ratePerUnit: "0.050000" }),
          makeRow({
            ratecardRanUsageLkpId: "01J000000000000000000000B0",
            polygonId: "PLY-2",
            ratePerUnit: null,
          }),
        ]}
        total={2}
        page={1}
        pageSize={50}
        query=""
      />,
    );
    expect(screen.getByText("0.050000")).toBeInTheDocument();
    // The null rate renders a muted em dash (at least one — present).
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders polygon start date as ISO (test 10)", () => {
    render(
      <RateCardRowPreview
        versionId="RCV00000001"
        rows={[makeRow({ polygonStartDate: "2026-09-30" })]}
        total={1}
        page={1}
        pageSize={50}
        query=""
      />,
    );
    expect(screen.getByText("2026-09-30")).toBeInTheDocument();
  });

  it("the no-rows-match-filter empty state names the query and offers Clear (test 11, empty state #2)", () => {
    render(
      <RateCardRowPreview
        versionId="RCV00000001"
        rows={[]}
        total={0}
        page={1}
        pageSize={50}
        query="MNO-9"
      />,
    );
    expect(screen.getByText("No rows match “MNO-9”.")).toBeInTheDocument();
    // "Clear filters" appears twice while filtered — the form-header clear and
    // the empty-state clear — both pointing at the same version-only href.
    const clears = screen.getAllByRole("link", { name: "Clear filters" });
    expect(clears.length).toBeGreaterThan(0);
    for (const link of clears) {
      expect(link).toHaveAttribute(
        "href",
        "/products/rate-card?version=RCV00000001",
      );
    }
  });

  it("the unfiltered-empty state reads DIFFERENTLY from the filter state (test 11)", () => {
    render(
      <RateCardRowPreview
        versionId="RCV00000001"
        rows={[]}
        total={0}
        page={1}
        pageSize={50}
        query=""
      />,
    );
    expect(
      screen.getByText("No rows to show for this version."),
    ).toBeInTheDocument();
    // No "No rows match" copy and no Clear-filters affordance when unfiltered.
    expect(screen.queryByText(/No rows match/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Clear filters" }),
    ).not.toBeInTheDocument();
  });

  it("distinguishes an out-of-range page (rows exist) from a genuinely empty version", () => {
    // total > 0 but no rows on this page → past-last-page, links to page 1.
    render(
      <RateCardRowPreview
        versionId="RCV00000001"
        rows={[]}
        total={120}
        page={99}
        pageSize={50}
        query=""
      />,
    );
    expect(screen.getByText(/This page is empty/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Go to the first page" }),
    ).toBeInTheDocument();
    // NOT the genuinely-empty-version copy.
    expect(
      screen.queryByText("No rows to show for this version."),
    ).not.toBeInTheDocument();
  });

  it("footer states Showing 1–n of N", () => {
    render(
      <RateCardRowPreview
        versionId="RCV00000001"
        rows={[makeRow()]}
        total={5400}
        page={1}
        pageSize={50}
        query=""
      />,
    );
    expect(screen.getByText(/Showing 1–50 of 5400 rows/)).toBeInTheDocument();
  });
});
