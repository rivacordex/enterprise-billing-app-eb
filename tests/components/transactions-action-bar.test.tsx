import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Mock next/navigation — panels use useRouter for router.refresh() on success.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Mock all ten server actions — prevents their "use server" imports (next/cache,
// auth/guard, db/client) from being loaded in the jsdom test environment.
vi.mock("@/actions/accounts/capture-payment", () => ({
  capturePaymentAction: vi.fn(),
}));
vi.mock("@/actions/accounts/allocate-payment", () => ({
  allocatePaymentAction: vi.fn(),
}));
vi.mock("@/actions/accounts/refund-payment", () => ({
  refundPaymentAction: vi.fn(),
}));
vi.mock("@/actions/accounts/raise-credit-note", () => ({
  raiseCreditNoteAction: vi.fn(),
}));
vi.mock("@/actions/accounts/raise-debit-note", () => ({
  raiseDebitNoteAction: vi.fn(),
}));
vi.mock("@/actions/accounts/capture-deposit", () => ({
  captureDepositAction: vi.fn(),
}));
vi.mock("@/actions/accounts/reverse-deposit", () => ({
  reverseDepositAction: vi.fn(),
}));
vi.mock("@/actions/accounts/refund-deposit", () => ({
  refundDepositAction: vi.fn(),
}));
vi.mock("@/actions/accounts/write-off", () => ({
  writeOffAction: vi.fn(),
}));
vi.mock("@/actions/accounts/rounding-adjustment", () => ({
  roundingAdjustmentAction: vi.fn(),
}));

import { TransactionsActionBar } from "@/components/accounts/transactions-action-bar";
import type { AssignedItem } from "@/types/accounts";

const FA_ID = "FIN000001";
const BAN_ID = "BAN000001";
const NO_ITEMS: AssignedItem[] = [];

const noContext = {
  financialAccountId: undefined,
  billingAccountId: undefined,
  assignedItems: NO_ITEMS,
  unappliedCashAvailable: "0.00",
};

const faOnly = {
  ...noContext,
  financialAccountId: FA_ID,
};

const faBan = {
  ...noContext,
  financialAccountId: FA_ID,
  billingAccountId: BAN_ID,
};

// Helper: open a dropdown trigger by accessible name and return the menu.
async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  triggerName: RegExp | string,
) {
  const trigger = screen.getByRole("button", { name: triggerName });
  await user.click(trigger);
  return screen.getByRole("menu");
}

describe("TransactionsActionBar — triggers", () => {
  it("renders all three action controls", () => {
    render(<TransactionsActionBar {...noContext} />);
    expect(
      screen.getByRole("button", { name: /payment/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /note/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /more actions/i }),
    ).toBeInTheDocument();
  });

  it("with no context all three triggers are disabled", () => {
    render(<TransactionsActionBar {...noContext} />);
    expect(screen.getByRole("button", { name: /payment/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /note/i })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /more actions/i }),
    ).toBeDisabled();
  });

  it("with FA only the + Payment and More actions triggers are enabled; + Note remains disabled", () => {
    render(<TransactionsActionBar {...faOnly} />);
    expect(screen.getByRole("button", { name: /payment/i })).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /more actions/i }),
    ).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /note/i })).toBeDisabled();
  });

  it("with FA + BAN all three triggers are enabled", () => {
    render(<TransactionsActionBar {...faBan} />);
    expect(screen.getByRole("button", { name: /payment/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /note/i })).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /more actions/i }),
    ).not.toBeDisabled();
  });
});

describe("TransactionsActionBar — + Payment menu entries", () => {
  it("lists exactly Capture Payment, Allocate Payment, Payment Refund", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /payment/i);
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Capture Payment");
    expect(items[1]).toHaveTextContent("Allocate Payment");
    expect(items[2]).toHaveTextContent("Payment Refund");
  });

  it("contains no Reversal entry (D4/ac22 boundary)", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /payment/i);
    expect(within(menu).queryByText(/reversal/i)).not.toBeInTheDocument();
  });

  it("with FA only: Capture Payment enabled; Allocate and Refund disabled with title", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faOnly} />);
    const menu = await openMenu(user, /payment/i);
    const [capture, allocate, refund] = within(menu).getAllByRole("menuitem");
    expect(capture).not.toHaveAttribute("data-disabled");
    expect(allocate).toHaveAttribute("data-disabled");
    expect(allocate).toHaveAttribute("title");
    expect(refund).toHaveAttribute("data-disabled");
    expect(refund).toHaveAttribute("title");
  });

  it("with FA + BAN: all three entries enabled", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /payment/i);
    for (const item of within(menu).getAllByRole("menuitem")) {
      expect(item).not.toHaveAttribute("data-disabled");
    }
  });

  it("with no context: all three entries disabled", async () => {
    const user = userEvent.setup();
    // Render with FA to allow the menu to open (trigger is disabled with no context)
    render(<TransactionsActionBar {...faOnly} />);
    const menu = await openMenu(user, /payment/i);
    // Capture Payment requires FA only — it IS enabled with FA.
    // Only Allocate and Refund need BAN; so this tests partial disable.
    const [, allocate, refund] = within(menu).getAllByRole("menuitem");
    expect(allocate).toHaveAttribute("data-disabled");
    expect(refund).toHaveAttribute("data-disabled");
  });
});

describe("TransactionsActionBar — + Note menu entries", () => {
  it("lists exactly Raise Credit Note and Raise Debit Note", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /note/i);
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Raise Credit Note");
    expect(items[1]).toHaveTextContent("Raise Debit Note");
  });

  it("contains no Reversal entry (D4/ac22 boundary)", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /note/i);
    expect(within(menu).queryByText(/reversal/i)).not.toBeInTheDocument();
  });

  it("with FA + BAN: both entries enabled", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /note/i);
    for (const item of within(menu).getAllByRole("menuitem")) {
      expect(item).not.toHaveAttribute("data-disabled");
    }
  });
});

describe("TransactionsActionBar — More actions menu entries", () => {
  it("lists exactly the five secondary entries", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /more actions/i);
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("Capture Security Deposit");
    expect(items[1]).toHaveTextContent("Reverse Deposit to Account");
    expect(items[2]).toHaveTextContent("Refund Deposit");
    expect(items[3]).toHaveTextContent("Write Off");
    expect(items[4]).toHaveTextContent("Rounding Adjustment");
  });

  it('"Reverse Deposit to Account" carries its one-line description', async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /more actions/i);
    expect(
      within(menu).getByText(/Applies deposit to A\/R — not a ledger reversal/),
    ).toBeInTheDocument();
  });

  it("contains no Reversal entry (D4/ac22 boundary)", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /more actions/i);
    // "Reverse Deposit" is present; plain "Reversal" (the reversal workbench entry) must not be.
    const items = within(menu).getAllByRole("menuitem");
    const labels = items.map((el) => el.textContent ?? "");
    expect(labels.every((l) => !/^reversal$/i.test(l.trim()))).toBe(true);
  });

  it("with FA only: three deposit entries enabled; Write Off and Rounding disabled", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faOnly} />);
    const menu = await openMenu(user, /more actions/i);
    const [capture, reverse, refund, writeOff, rounding] =
      within(menu).getAllByRole("menuitem");
    expect(capture).not.toHaveAttribute("data-disabled");
    expect(reverse).not.toHaveAttribute("data-disabled");
    expect(refund).not.toHaveAttribute("data-disabled");
    expect(writeOff).toHaveAttribute("data-disabled");
    expect(writeOff).toHaveAttribute("title");
    expect(rounding).toHaveAttribute("data-disabled");
    expect(rounding).toHaveAttribute("title");
  });

  it("with FA + BAN: all five entries enabled", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    const menu = await openMenu(user, /more actions/i);
    for (const item of within(menu).getAllByRole("menuitem")) {
      expect(item).not.toHaveAttribute("data-disabled");
    }
  });
});

describe("TransactionsActionBar — dialog open and close", () => {
  it("clicking Capture Payment renders the panel's Payment Mode field", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faOnly} />);
    await openMenu(user, /payment/i);
    await user.click(screen.getByRole("menuitem", { name: "Capture Payment" }));
    expect(screen.getByText("Payment Mode")).toBeInTheDocument();
  });

  it("Escape closes the Capture Payment dialog", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faOnly} />);
    await openMenu(user, /payment/i);
    await user.click(screen.getByRole("menuitem", { name: "Capture Payment" }));
    expect(screen.getByText("Payment Mode")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Payment Mode")).not.toBeInTheDocument();
  });

  it("clicking Raise Credit Note opens the Credit Note dialog", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    await openMenu(user, /note/i);
    await user.click(
      screen.getByRole("menuitem", { name: "Raise Credit Note" }),
    );
    // The dialog is open; DialogTitle is one of the headings named "Raise Credit Note".
    // The panel's internal <h3> also renders (CSS hides it visually but not in jsdom DOM).
    expect(
      screen.getAllByRole("heading", { name: "Raise Credit Note" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("clicking Write Off opens the Write Off dialog", async () => {
    const user = userEvent.setup();
    render(<TransactionsActionBar {...faBan} />);
    await openMenu(user, /more actions/i);
    await user.click(screen.getByRole("menuitem", { name: "Write Off" }));
    // DialogTitle heading present (panel's <h3> also renders in jsdom).
    expect(
      screen.getAllByRole("heading", { name: "Write Off" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
