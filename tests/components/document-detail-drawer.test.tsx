// ac21-spec §3.5 — component tests for DocumentDetailDrawer.
// SC11: approval timeline + Approve render for pending_approval; absent for posted.
// SC14: READ-only holder sees full drawer but no Approve/Reject.
// closeHref regression: closing preserves party/fa/ban AND type/status/rev/q/sort/page.

// Mock next/navigation — DocumentApprovalActions uses useRouter.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Mock approveDocumentAction — prevents "use server" imports in jsdom.
vi.mock("@/actions/accounts/approve-document", () => ({
  approveDocumentAction: vi.fn(),
}));

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DocumentDetailDrawer } from "@/components/accounts/document-detail-drawer";
import type {
  Document,
  DocumentLine,
  TransactionDocumentDetail,
} from "@/types/accounts";

const FA_ID = "FIN000001";
const BAN_ID = "BAN000001";
const CREATOR_ID = "user-creator-01";
const APPROVER_ID = "user-manager-01";
const NOW = new Date("2026-03-15T10:00:00Z");

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    documentId: "PAY00000001",
    docType: "PAY",
    state: "posted",
    refFinancialAccountId: FA_ID,
    refBillingAccountId: null,
    reasonCode: "CUST_PAYMENT",
    currency: "MYR",
    totalAmount: "1000.00",
    paymentMode: null,
    modeRef: null,
    referenceDate: NOW,
    referenceInfo: "Test reference",
    eventAt: NOW,
    postedAt: NOW,
    reversalOf: null,
    createdBy: CREATOR_ID,
    approvedBy: null,
    metadata: null,
    lastModified: NOW,
    lastEditedBy: CREATOR_ID,
    ...overrides,
  };
}

function makeLine(overrides: Partial<DocumentLine> = {}): DocumentLine {
  return {
    documentLineId: "DLN00000001",
    refDocumentId: "PAY00000001",
    lineNo: 1,
    lineKind: "capture",
    refBillingAccountId: null,
    refSettledDocumentId: null,
    amount: "1000.00",
    pgledgerTransferId: null,
    reversedByLineId: null,
    lastModified: NOW,
    lastEditedBy: CREATOR_ID,
    ...overrides,
  };
}

function makeDetail(
  overrides: Partial<TransactionDocumentDetail> = {},
): TransactionDocumentDetail {
  return {
    document: makeDocument(),
    lines: [],
    partiallyReversed: false,
    reversedByDocumentId: null,
    ...overrides,
  };
}

const BASE_PROPS = {
  closeHref: "/accounts/transactions?party=PTRL001&fa=FIN000001&ban=BAN000001",
  locale: "en-MY",
  timezone: "Asia/Kuala_Lumpur",
  canEdit: true,
  currentUserId: APPROVER_ID,
};

describe("DocumentDetailDrawer — SC11 pending_approval controls", () => {
  it("shows Approve & post button for pending_approval when canEdit", () => {
    const detail = makeDetail({
      document: makeDocument({ state: "pending_approval", postedAt: null }),
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(
      screen.getByRole("button", { name: /approve.*post/i }),
    ).toBeInTheDocument();
  });

  it("does not show Approve & post for posted documents", () => {
    const detail = makeDetail({
      document: makeDocument({ state: "posted" }),
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(
      screen.queryByRole("button", { name: /approve.*post/i }),
    ).not.toBeInTheDocument();
  });

  it("shows Awaiting approval status in timeline for pending_approval", () => {
    const detail = makeDetail({
      document: makeDocument({ state: "pending_approval", postedAt: null }),
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument();
  });

  it("does not show Awaiting approval for posted documents", () => {
    const detail = makeDetail({ document: makeDocument({ state: "posted" }) });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.queryByText(/awaiting approval/i)).not.toBeInTheDocument();
  });
});

describe("DocumentDetailDrawer — SC14 READ-only has no approve controls", () => {
  it("does not render Approve & post when canEdit=false, even for pending_approval", () => {
    const detail = makeDetail({
      document: makeDocument({ state: "pending_approval", postedAt: null }),
    });
    render(
      <DocumentDetailDrawer {...BASE_PROPS} canEdit={false} detail={detail} />,
    );
    expect(
      screen.queryByRole("button", { name: /approve.*post/i }),
    ).not.toBeInTheDocument();
  });

  it("still shows document details for READ-only viewer", () => {
    const detail = makeDetail({
      document: makeDocument({ state: "pending_approval", postedAt: null }),
    });
    render(
      <DocumentDetailDrawer {...BASE_PROPS} canEdit={false} detail={detail} />,
    );
    expect(screen.getByText("PAY00000001")).toBeInTheDocument();
    expect(screen.getByText(/cust_payment/i)).toBeInTheDocument();
  });
});

describe("DocumentDetailDrawer — closeHref preserves context and filters", () => {
  it("close button href preserves party/fa/ban and filter params", () => {
    const closeHref =
      "/accounts/transactions?party=PTRL001&fa=FIN000001&ban=BAN000001&type=PAY&status=posted&rev=reversible&q=PAY00000001&sort=amount&page=3";
    const detail = makeDetail();
    render(
      <DocumentDetailDrawer
        {...BASE_PROPS}
        closeHref={closeHref}
        detail={detail}
      />,
    );
    const closeLink = screen.getByRole("link", {
      name: /close document detail/i,
    });
    expect(closeLink).toHaveAttribute("href", closeHref);
  });

  it("close button exists with aria-label", () => {
    const detail = makeDetail();
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(
      screen.getByRole("link", { name: /close document detail/i }),
    ).toBeInTheDocument();
  });
});

describe("DocumentDetailDrawer — lines and ledger legs", () => {
  it("renders lines with their line kind and amount", () => {
    const detail = makeDetail({
      document: makeDocument(),
      lines: [
        {
          line: makeLine({ lineNo: 1, lineKind: "capture", amount: "1000.00" }),
          transfer: null,
        },
      ],
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText(/capture/i)).toBeInTheDocument();
  });

  it("renders em-dash when transfer is null for a line with pgledgerTransferId", () => {
    const detail = makeDetail({
      document: makeDocument(),
      lines: [
        {
          line: makeLine({
            pgledgerTransferId: "pglt_missing",
          }),
          transfer: null,
        },
      ],
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    // The em-dash is rendered as text "—"
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders transfer legs when transfer is present", () => {
    const detail = makeDetail({
      document: makeDocument(),
      lines: [
        {
          line: makeLine({ pgledgerTransferId: "pglt_001" }),
          transfer: {
            id: "pglt_001",
            fromAccountId: "pgla_001",
            fromAccountName: "fa.unapplied_cash.MYR",
            toAccountId: "pgla_002",
            toAccountName: "sys.cash.MYR",
            amount: "1000.00",
            eventAt: NOW,
          },
        },
      ],
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.getByText("fa.unapplied_cash.MYR")).toBeInTheDocument();
    expect(screen.getByText("sys.cash.MYR")).toBeInTheDocument();
  });

  it("shows Reversed badge for lines with reversedByLineId set", () => {
    const detail = makeDetail({
      document: makeDocument(),
      lines: [
        {
          line: makeLine({ reversedByLineId: "DLN00000002" }),
          transfer: null,
        },
      ],
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.getByText(/reversed/i)).toBeInTheDocument();
  });

  it("renders FA-level scope chip when refBillingAccountId is null", () => {
    const detail = makeDetail({
      document: makeDocument({ refBillingAccountId: null }),
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.getByText(/fa-level/i)).toBeInTheDocument();
  });

  it("renders BAN scope chip when refBillingAccountId is set", () => {
    const detail = makeDetail({
      document: makeDocument({ refBillingAccountId: BAN_ID }),
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.getByText(BAN_ID)).toBeInTheDocument();
  });
});

describe("DocumentDetailDrawer — cross-links", () => {
  it("shows Reverses cross-link when reversalOf is set", () => {
    const detail = makeDetail({
      document: makeDocument({ reversalOf: "PAY00000002" }),
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.getByText("PAY00000002")).toBeInTheDocument();
  });

  it("shows Reversed by cross-link when reversedByDocumentId is set", () => {
    const detail = makeDetail({ reversedByDocumentId: "PAY00000003" });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.getByText("PAY00000003")).toBeInTheDocument();
  });

  it("omits cross-links section when both are null", () => {
    const detail = makeDetail({
      document: makeDocument({ reversalOf: null }),
      reversedByDocumentId: null,
    });
    render(<DocumentDetailDrawer {...BASE_PROPS} detail={detail} />);
    expect(screen.queryByText(/reverses/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/reversed by/i)).not.toBeInTheDocument();
  });
});
