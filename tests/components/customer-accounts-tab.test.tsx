import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AccountsLockedCard } from "@/components/customers/accounts-locked-card";
import { CustomerAccountsTab } from "@/components/customers/customer-accounts-tab";
import type {
  CustomerAccountsSummary,
  TransactionDocumentRow,
} from "@/types/accounts";

// cm20-spec §3.8 — the four Accounts tab states (the locked state is the
// page's AccountsLockedCard; the tab body never sees it), document deep-links
// and pagination links.

function doc(n: number): TransactionDocumentRow {
  return {
    documentId: `DBN0000000${n}`,
    docType: "DBN",
    state: "posted",
    refFinancialAccountId: "FIN00000001",
    refBillingAccountId: "BAN00000001",
    reasonCode: "LATE_FEE",
    currency: "MYR",
    totalAmount: "10.00",
    createdBy: "u1",
    approvedBy: null,
    eventAt: new Date("2026-10-01T10:00:00.000Z"),
    lastModified: new Date("2026-10-01T10:00:00.000Z"),
    unreversedLineCount: 1,
    totalLineCount: 1,
    partiallyReversed: false,
    reversible: true,
    actionLabel: "Debit Note — LATE_FEE",
  };
}

function onboarded(
  documents: { rows: TransactionDocumentRow[]; total: number; page: number },
  banState: "active" | "suspended" | "closed" = "active",
): CustomerAccountsSummary {
  return {
    kind: "onboarded",
    financialAccounts: [
      {
        financialAccountId: "FIN00000001",
        state: "active",
        currency: "MYR",
        receivableBalance: "1250.00",
        unappliedCashBalance: "-40.00",
        depositBalance: "0.00",
        bans: [
          {
            billingAccountId: "BAN00000001",
            name: "Master Billing Account",
            state: banState,
            billCycleName: "Monthly – Day 1",
            paymentTermDays: 30,
            receivableBalance: "1250.00",
            templateLabel:
              "Follows active template (currently: INVTPL-STD-A4 v1), as of now",
          },
        ],
        documents: { ...documents, pageSize: 2 },
      },
    ],
  };
}

function renderTab(summary: CustomerAccountsSummary): void {
  render(
    <CustomerAccountsTab
      partyRoleId="PTRL00000001"
      summary={summary}
      locale="en-US"
      timezone="UTC"
    />,
  );
}

describe("Accounts tab states", () => {
  it("locked: 'Requires accounts access'", () => {
    render(<AccountsLockedCard />);
    expect(screen.getByText("Requires accounts access")).toBeInTheDocument();
  });

  it("not onboarded: the info card", () => {
    renderTab({ kind: "notOnboarded" });
    expect(
      screen.getByText("Accounts are created when the customer is validated."),
    ).toBeInTheDocument();
  });

  it("onboarded, empty: FA + BAN cards and 'No transactions yet.'", () => {
    renderTab(onboarded({ rows: [], total: 0, page: 1 }));

    const fa = screen.getByRole("region", {
      name: "Financial account FIN00000001",
    });
    expect(within(fa).getByText("Unapplied cash")).toBeInTheDocument();
    expect(within(fa).getByText("(40.00)")).toBeInTheDocument();

    const banCard = screen.getByRole("region", {
      name: "Billing account BAN00000001",
    });
    expect(within(banCard).getByText("Active")).toBeInTheDocument();
    expect(within(banCard).getByText("Monthly – Day 1")).toBeInTheDocument();
    expect(within(banCard).getByText("30 days")).toBeInTheDocument();
    expect(within(banCard).getByText("1,250.00")).toBeInTheDocument();
    expect(
      within(banCard).getByText(
        (_, el) =>
          el?.tagName === "P" &&
          el.textContent ===
            "Follows active template (currently: INVTPL-STD-A4 v1), as of now",
      ),
    ).toBeInTheDocument();

    expect(screen.getByText("No transactions yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("normal: document rows deep-link into Accounts → Transactions", () => {
    renderTab(onboarded({ rows: [doc(1), doc(2)], total: 2, page: 1 }));

    const link = screen.getByRole("link", { name: "DBN00000001" });
    expect(link).toHaveAttribute(
      "href",
      "/accounts/transactions?party=PTRL00000001&fa=FIN00000001&doc=DBN00000001",
    );
    expect(screen.getAllByText("Debit Note — LATE_FEE")).toHaveLength(2);
    expect(screen.getAllByText("Posted")).toHaveLength(2);
    expect(
      screen.queryByRole("navigation", { name: "Documents pagination" }),
    ).not.toBeInTheDocument();
  });

  it("no action buttons are rendered in the tab", () => {
    renderTab(onboarded({ rows: [doc(1)], total: 1, page: 1 }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("a closed BAN card renders muted with the Closed chip", () => {
    renderTab(onboarded({ rows: [], total: 0, page: 1 }, "closed"));
    const banCard = screen.getByRole("region", {
      name: "Billing account BAN00000001",
    });
    expect(banCard).toHaveClass("opacity-60");
    expect(within(banCard).getByText("Closed")).toBeInTheDocument();
  });
});

describe("Accounts tab pagination", () => {
  it("first page: Next only, keeping tab=accounts", () => {
    renderTab(onboarded({ rows: [doc(1), doc(2)], total: 5, page: 1 }));

    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "?tab=accounts&page=2",
    );
    expect(
      screen.queryByRole("link", { name: "Previous" }),
    ).not.toBeInTheDocument();
  });

  it("middle page: Previous and Next both keep tab=accounts", () => {
    renderTab(onboarded({ rows: [doc(3), doc(4)], total: 5, page: 2 }));

    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "?tab=accounts&page=1",
    );
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "?tab=accounts&page=3",
    );
  });

  it("last page: Previous only", () => {
    renderTab(onboarded({ rows: [doc(5)], total: 5, page: 3 }));

    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "?tab=accounts&page=2",
    );
    expect(
      screen.queryByRole("link", { name: "Next" }),
    ).not.toBeInTheDocument();
  });
});
