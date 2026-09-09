// bm20-spec §Design D8/D9, bm-review fix. Posting completes into INVOICED (not
// COMPLETED). The completion message must key on an ALLOWLIST of at-or-past-
// posting statuses, never a `!== APPROVED && !== POSTING` denylist: the approve
// route falls through to this view for ANY non-PROCESSED run, so a denylist
// showed a false green "posting complete" over a run still SCHEDULED/PROCESSING
// or one that FAILED/was CANCELLED before posting ever ran. The action-backed
// controls are mocked so their db/service graph never loads.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/actions/billing/post-run.action", () => ({
  postRunAction: vi.fn(),
}));
vi.mock("@/actions/billing/retry-render-invoice.action", () => ({
  retryRenderInvoiceAction: vi.fn(),
}));
vi.mock("@/components/billing/invoice-preview-modal", () => ({
  StoredInvoiceModal: () => null,
}));

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { PostingProgressView } from "@/components/billing/posting-progress-view";
import type { PostingProgress } from "@/types/billing";

function progress(overrides: Partial<PostingProgress> = {}): PostingProgress {
  return {
    billRunId: "BRN00000001",
    runStatus: "INVOICED",
    rows: [],
    postedCount: 1,
    totalCount: 1,
    ...overrides,
  };
}

function renderView(p: PostingProgress) {
  return render(
    <PostingProgressView
      progress={p}
      cycleName="Monthly – Day 1"
      periodStart="2026-07-01"
      periodEnd="2026-07-31"
    />,
  );
}

const COMPLETION_MESSAGE = /All accounts invoiced|Posting complete/;

describe("PostingProgressView completion messaging (bm-review fix)", () => {
  it("shows the completion message once the run has reached INVOICED", () => {
    const { getByText } = renderView(progress({ runStatus: "INVOICED" }));
    expect(
      getByText(/All accounts invoiced\. See the Distribution tab/),
    ).toBeTruthy();
  });

  it.each(["DISTRIBUTING", "COMPLETED", "DISTRIBUTION_FAILED"] as const)(
    "shows the completion message for %s (at or past posting)",
    (runStatus) => {
      const { getByText } = renderView(progress({ runStatus }));
      expect(getByText(COMPLETION_MESSAGE)).toBeTruthy();
    },
  );

  it.each([
    "SCHEDULED",
    "PROCESSING",
    "PROCESSING_FAILED",
    "CANCELLED",
  ] as const)(
    "shows NEITHER the completion message nor a Post button for %s (not yet / never posted)",
    (runStatus) => {
      const { queryByText, queryByRole } = renderView(progress({ runStatus }));
      expect(queryByText(COMPLETION_MESSAGE)).toBeNull();
      expect(queryByRole("button")).toBeNull();
    },
  );

  it.each(["APPROVED", "POSTING"] as const)(
    "shows the Post/Retry button (and no completion message) while %s",
    (runStatus) => {
      const { queryByText, getByRole } = renderView(progress({ runStatus }));
      expect(queryByText(COMPLETION_MESSAGE)).toBeNull();
      expect(getByRole("button")).toBeTruthy();
    },
  );
});
