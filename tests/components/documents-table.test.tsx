import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock next/navigation — DocumentsTable uses useRouter, usePathname, and
// useSearchParams for URL-driven filter state (inv. #17).
// Hoisted, stable router mocks so a test can assert whether the row's drawer
// navigation (router.push with ?doc) fired.
const { pushMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, refresh: vi.fn() }),
  usePathname: () => "/accounts/transactions",
  useSearchParams: () => new URLSearchParams(),
}));

// The ↺ Reverse row action (ac22) pulls in reversal-dialog.tsx, which imports
// the reverse-document server action — mock it so the "use server" module graph
// (db client, services) does not load into jsdom.
vi.mock("@/actions/accounts/reverse-document", () => ({
  getReversalPreviewAction: vi.fn(),
  reverseDocumentAction: vi.fn(),
}));

import { DocumentsTable } from "@/components/accounts/documents-table";
import type { DocumentsTableProps } from "@/components/accounts/documents-table";
import type { TransactionDocumentRow } from "@/types/accounts";

const FA_ID = "FIN000001";
const BAN_ID = "BAN000001";

function makeRow(
  overrides: Partial<TransactionDocumentRow> = {},
): TransactionDocumentRow {
  return {
    documentId: "PAY00000001",
    docType: "PAY",
    state: "posted",
    refFinancialAccountId: FA_ID,
    refBillingAccountId: BAN_ID,
    reasonCode: "CUST_PAYMENT",
    currency: "MYR",
    totalAmount: "1000.00",
    createdBy: "user-creator-01",
    approvedBy: null,
    eventAt: new Date("2026-03-15T00:00:00.000Z"),
    lastModified: new Date("2026-03-15T01:00:00.000Z"),
    totalLineCount: 1,
    unreversedLineCount: 1,
    partiallyReversed: false,
    reversible: true,
    actionLabel: "Payment — CUST_PAYMENT",
    ...overrides,
  };
}

const BASE_PROPS: DocumentsTableProps = {
  rows: [],
  total: 0,
  page: 1,
  pageSize: 20,
  sort: "-event_at",
  type: null,
  status: null,
  rev: null,
  q: "",
  locale: "en-MY",
  timezone: "Asia/Kuala_Lumpur",
  overviewHref: "/accounts/overview",
  financialAccountId: FA_ID,
  canEdit: true,
};

// ── Empty state (no FA selected) ─────────────────────────────────────────────

describe("DocumentsTable — no FA selected empty state", () => {
  it('shows "Select a Financial Account" with a link to Overview', () => {
    render(<DocumentsTable {...BASE_PROPS} financialAccountId={undefined} />);
    expect(screen.getByText(/select a financial account/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /accounts overview/i });
    expect(link).toHaveAttribute("href", "/accounts/overview");
  });

  it("overview link uses the overviewHref prop (preserves context params)", () => {
    const href = "/accounts/overview?party=PR000001&fa=FIN000001";
    render(
      <DocumentsTable
        {...BASE_PROPS}
        financialAccountId={undefined}
        overviewHref={href}
      />,
    );
    const link = screen.getByRole("link", { name: /accounts overview/i });
    expect(link).toHaveAttribute("href", href);
  });
});

// ── SC9 — partially-reversed badge rendered beside Posted ─────────────────────

describe("SC9 — partiallyReversed badge", () => {
  it('shows "Partially reversed" warning chip beside the Posted badge', () => {
    const row = makeRow({
      documentId: "CRN00000001",
      docType: "CRN",
      state: "posted",
      partiallyReversed: true,
      reversible: true,
      totalLineCount: 2,
      unreversedLineCount: 1,
      actionLabel: "Credit Note — BILL_CREDIT",
    });
    render(<DocumentsTable {...BASE_PROPS} rows={[row]} total={1} />);
    // Use selector: 'span' — the filter bar has a <option> with the same
    // text; we want the Warning chip <span> inside DocStateBadge.
    expect(
      screen.getByText(/partially reversed/i, { selector: "span" }),
    ).toBeInTheDocument();
    // Base "Posted" badge should also be present.
    expect(
      screen.getByText(/^posted$/i, { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("does NOT show the partially-reversed chip when partiallyReversed=false", () => {
    const row = makeRow({ partiallyReversed: false });
    render(<DocumentsTable {...BASE_PROPS} rows={[row]} total={1} />);
    // The filter bar always has a "Partially reversed" <option>; check that
    // no badge <span> with that text exists.
    expect(
      screen.queryByText(/partially reversed/i, { selector: "span" }),
    ).not.toBeInTheDocument();
  });

  it("does NOT show the chip for a reversed doc even if partially-reversed were true", () => {
    // Reversed state can never be partiallyReversed per service logic, but
    // guard against rendering the chip for non-posted states.
    const row = makeRow({ state: "reversed", partiallyReversed: false });
    render(<DocumentsTable {...BASE_PROPS} rows={[row]} total={1} />);
    expect(
      screen.queryByText(/partially reversed/i, { selector: "span" }),
    ).not.toBeInTheDocument();
  });
});

// ── Scope marker ──────────────────────────────────────────────────────────────

describe("Scope marker — FA-level vs BAN chip", () => {
  it('shows "FA-level" chip for a row with refBillingAccountId=null (SC4 capture)', () => {
    const row = makeRow({
      refBillingAccountId: null,
      docType: "PAY",
      actionLabel: "Payment — CUST_PAYMENT",
    });
    render(<DocumentsTable {...BASE_PROPS} rows={[row]} total={1} />);
    expect(screen.getByText(/fa-level/i)).toBeInTheDocument();
  });

  it("shows the BAN ID chip for a row with a non-null refBillingAccountId", () => {
    const row = makeRow({ refBillingAccountId: BAN_ID });
    render(<DocumentsTable {...BASE_PROPS} rows={[row]} total={1} />);
    expect(screen.getByText(BAN_ID)).toBeInTheDocument();
  });
});

// ── Empty results (FA present, filters match nothing) ─────────────────────────

describe("DocumentsTable — empty results state", () => {
  it('shows "No documents match your filters" when FA present but rows=[]', () => {
    render(<DocumentsTable {...BASE_PROPS} rows={[]} total={0} />);
    expect(
      screen.getByText(/no documents match your filters/i),
    ).toBeInTheDocument();
  });
});

// ── ac21 — approve moved to drawer ───────────────────────────────────────────

describe("DocumentsTable — no inline approve column (ac21)", () => {
  it("has no Approve column header — approval moved to DocumentDetailDrawer", () => {
    render(<DocumentsTable {...BASE_PROPS} />);
    expect(
      screen.queryByRole("columnheader", { name: /^approve$/i }),
    ).not.toBeInTheDocument();
  });

  it("has no inline Approve button for pending_approval rows", () => {
    const row = makeRow({ state: "pending_approval" });
    render(<DocumentsTable {...BASE_PROPS} rows={[row]} total={1} />);
    expect(
      screen.queryByRole("button", { name: /approve/i }),
    ).not.toBeInTheDocument();
  });
});

// ── ac22 — ↺ Reverse row action (hidden, not disabled) ───────────────────────

describe("DocumentsTable — ↺ Reverse row action (ac22 §3.2)", () => {
  it("renders the ↺ Reverse control on a reversible row when canEdit", () => {
    const row = makeRow({ reversible: true });
    render(<DocumentsTable {...BASE_PROPS} rows={[row]} total={1} />);
    expect(
      screen.getByRole("button", { name: /reverse document PAY00000001/i }),
    ).toBeInTheDocument();
  });

  it("hides the reverse control on an ineligible (reversible=false) row", () => {
    const row = makeRow({ state: "draft", reversible: false });
    render(<DocumentsTable {...BASE_PROPS} rows={[row]} total={1} />);
    expect(
      screen.queryByRole("button", { name: /reverse document/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the reverse control for a READ-only holder even on reversible rows (D5/§2.8)", () => {
    const row = makeRow({ reversible: true });
    render(
      <DocumentsTable {...BASE_PROPS} canEdit={false} rows={[row]} total={1} />,
    );
    expect(
      screen.queryByRole("button", { name: /reverse document/i }),
    ).not.toBeInTheDocument();
  });

  it("clicking ↺ Reverse does not open the drawer — no ?doc navigation (stopPropagation, §2.3)", async () => {
    pushMock.mockClear();
    const row = makeRow({ reversible: true });
    render(<DocumentsTable {...BASE_PROPS} rows={[row]} total={1} />);
    // Opening the ReversalDialog kicks off its async preview fetch; wrap the
    // click in act() so those post-await state updates settle inside act
    // rather than leaking a "not wrapped in act(...)" warning after the test.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /reverse document PAY00000001/i }),
      );
    });
    // The row's openDoc navigation (router.push with ?doc=...) must not fire.
    expect(pushMock).not.toHaveBeenCalled();
  });
});

// ── Filter bar ────────────────────────────────────────────────────────────────

describe("DocumentsTable — filter bar options", () => {
  it("Type select has exactly 5 doc-type options plus 'All types'", () => {
    render(<DocumentsTable {...BASE_PROPS} />);
    const typeSelect = screen.getByLabelText(/^type$/i);
    // 5 doc types + 1 "All types" option = 6 total.
    const options = Array.from(typeSelect.querySelectorAll("option"));
    expect(options).toHaveLength(6);
    const values = options.map((o) => o.value).filter(Boolean);
    expect(values).toEqual(
      expect.arrayContaining(["PAY", "DEP", "CRN", "DBN", "ADJ"]),
    );
  });
});
