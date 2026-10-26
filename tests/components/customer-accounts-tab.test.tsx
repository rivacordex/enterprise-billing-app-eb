import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AccountsLockedCard } from "@/components/customers/accounts-locked-card";
import { TemplateLabel } from "@/components/customers/billing-account-card";
import { CustomerAccountsTab } from "@/components/customers/customer-accounts-tab";
import type {
  AccountState,
  BanTemplateLabel,
  CustomerAccountsSummary,
  TransactionDocumentRow,
} from "@/types/accounts";

const STANDARD_LABEL: BanTemplateLabel = {
  kind: "STANDARD",
  text: "Standard (default) · v1",
  name: "Standard (default)",
  versionNo: 1,
};

// cm20-spec §3.8 — the four Accounts tab states (the locked state is the
// page's AccountsLockedCard; the tab body never sees it), document deep-links
// and pagination links.

// The label's accessible text is visually hidden ("Invoice template type:
// {text}"), since a <p> can't carry an aria-label; returns the label's <p>.
function templateLabel(
  text: string,
  scope: Pick<typeof screen, "getByText"> = screen,
): HTMLElement {
  const p = scope.getByText(`Invoice template type: ${text}`).closest("p");
  if (p === null) throw new Error(`no template label for ${text}`);
  return p;
}

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
  banState: AccountState = "active",
  faState: AccountState = "active",
  templateLabel: BanTemplateLabel = STANDARD_LABEL,
): CustomerAccountsSummary {
  return {
    kind: "onboarded",
    financialAccounts: [
      {
        financialAccountId: "FIN00000001",
        state: faState,
        currency: "MYR",
        receivableBalance: "1250.00",
        unappliedCashBalance: "-40.00",
        depositBalance: "0.00",
        bans: [
          {
            billingAccountId: "BAN00000001",
            name: "Master Billing Account",
            state: banState,
            currency: "USD",
            billCycleName: "Monthly – Day 1",
            paymentTermDays: 30,
            receivableBalance: "1250.00",
            templateLabel,
          },
        ],
        documents: { ...documents, pageSize: 2 },
      },
    ],
  };
}

function renderTab(
  summary: CustomerAccountsSummary,
  canOpenDocuments = true,
): void {
  render(
    <CustomerAccountsTab
      partyRoleId="PTRL00000001"
      summary={summary}
      canOpenDocuments={canOpenDocuments}
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
    // The BAN receivable is in the BAN's own currency, not the FA's.
    expect(within(banCard).getByText("USD")).toBeInTheDocument();
    expect(within(banCard).queryByText("MYR")).not.toBeInTheDocument();
    const label = templateLabel("Standard (default) · v1", within(banCard));
    expect(label).toHaveTextContent(
      "Invoice template typeStandard (default) · v1",
    );

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
      screen.queryByRole("navigation", {
        name: "Documents pagination for FIN00000001",
      }),
    ).not.toBeInTheDocument();
  });

  it("without accounts_transactions : READ, document ids are plain text, not links", () => {
    renderTab(onboarded({ rows: [doc(1), doc(2)], total: 2, page: 1 }), false);

    expect(screen.getByText("DBN00000001")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "DBN00000001" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /^DBN/ }),
    ).not.toBeInTheDocument();
  });

  it("the FA card shows its state chip and mutes when closed", () => {
    renderTab(onboarded({ rows: [], total: 0, page: 1 }, "closed", "closed"));
    const fa = screen.getByRole("region", {
      name: "Financial account FIN00000001",
    });
    expect(fa).toHaveClass("opacity-60");
    expect(within(fa).getByText("Closed")).toBeInTheDocument();
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
  it("first page: Next only, keeping tab=accounts and scoped to the FA", () => {
    renderTab(onboarded({ rows: [doc(1), doc(2)], total: 5, page: 1 }));

    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "?tab=accounts&fa=FIN00000001&page=2",
    );
    expect(
      screen.queryByRole("link", { name: "Previous" }),
    ).not.toBeInTheDocument();
  });

  it("middle page: Previous and Next both keep tab=accounts", () => {
    renderTab(onboarded({ rows: [doc(3), doc(4)], total: 5, page: 2 }));

    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "?tab=accounts&fa=FIN00000001&page=1",
    );
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "?tab=accounts&fa=FIN00000001&page=3",
    );
  });

  it("last page: Previous only", () => {
    renderTab(onboarded({ rows: [doc(5)], total: 5, page: 3 }));

    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "?tab=accounts&fa=FIN00000001&page=2",
    );
    expect(
      screen.queryByRole("link", { name: "Next" }),
    ).not.toBeInTheDocument();
  });
});

// cm23-spec §3.10 / custmgmt-ui-context §10.1 — the structured type label.
describe("TemplateLabel (cm23)", () => {
  it("a bound type: the field label, the name, and v{N} in mono", () => {
    render(
      <TemplateLabel
        label={{
          kind: "TYPE",
          text: "Wholesale · v3",
          name: "Wholesale",
          versionNo: 3,
        }}
      />,
    );

    const label = templateLabel("Wholesale · v3");
    expect(
      within(label).getByText("Invoice template type"),
    ).toBeInTheDocument();
    expect(label).toHaveTextContent("Wholesale · v3");
    const version = within(label).getByText("v3");
    expect(version).toHaveClass("font-mono");
    expect(within(label).queryByText(/not usable/)).toBeNull();
  });

  it("the BAN card renders the summary's label", () => {
    renderTab(
      onboarded({ rows: [], total: 0, page: 1 }, "active", "active", {
        kind: "TYPE",
        text: "Wholesale · v1",
        name: "Wholesale",
        versionNo: 1,
      }),
    );

    const banCard = screen.getByRole("region", {
      name: "Billing account BAN00000001",
    });
    expect(templateLabel("Wholesale · v1", within(banCard))).toHaveTextContent(
      "Wholesale · v1",
    );
  });

  it("NOT_USABLE: '· not usable' in the warning family with the warning icon, no version", () => {
    render(
      <TemplateLabel
        label={{
          kind: "NOT_USABLE",
          text: "Wholesale · not usable",
          name: "Wholesale",
          versionNo: null,
        }}
      />,
    );

    const label = templateLabel("Wholesale · not usable");
    const warning = within(label).getByText("· not usable");
    expect(warning.className).toContain("--color-warning-700");
    const icon = warning.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class")).toContain("--color-warning-500");
    expect(within(label).queryByText(/^v\d+$/)).toBeNull();
  });

  it("assistive tech reads one string: the hidden text, with the styled parts aria-hidden", () => {
    render(
      <TemplateLabel
        label={{
          kind: "TYPE",
          text: "Wholesale · v3",
          name: "Wholesale",
          versionNo: 3,
        }}
      />,
    );

    const label = templateLabel("Wholesale · v3");
    expect(label).not.toHaveAttribute("aria-label");
    expect(
      screen.getByText("Invoice template type: Wholesale · v3"),
    ).toHaveClass("sr-only");
    for (const part of [
      screen.getByText("Invoice template type"),
      screen.getByText("v3").closest("span[aria-hidden]"),
    ]) {
      expect(part).toHaveAttribute("aria-hidden", "true");
    }
  });
});
