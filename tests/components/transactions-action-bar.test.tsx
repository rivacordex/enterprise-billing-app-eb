import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The ten create-panels each import their own server action at module scope
// (byte-identical, inv. #20) — mocked here so mounting a panel inside its
// dialog never pulls in the real db/client → env-config chain, matching the
// established pattern for dialog-wrapped server actions (e.g.
// create-role-dialog.test.tsx).
vi.mock("@/actions/accounts/capture-payment", () => ({
  capturePaymentAction: vi.fn(),
}));
vi.mock("@/actions/accounts/allocate-payment", () => ({
  allocatePaymentAction: vi.fn(),
}));
vi.mock("@/actions/accounts/refund-payment", () => ({
  refundPaymentAction: vi.fn(),
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
vi.mock("@/actions/accounts/raise-debit-note", () => ({
  raiseDebitNoteAction: vi.fn(),
}));
vi.mock("@/actions/accounts/raise-credit-note", () => ({
  raiseCreditNoteAction: vi.fn(),
}));
vi.mock("@/actions/accounts/write-off", () => ({
  writeOffAction: vi.fn(),
}));
vi.mock("@/actions/accounts/rounding-adjustment", () => ({
  roundingAdjustmentAction: vi.fn(),
}));

import { TransactionsActionBar } from "@/components/accounts/transactions-action-bar";

const BAN_MISSING_TITLE = "Select a Billing Account in Overview";
const FA_MISSING_TITLE = "Select a Financial Account in Overview";

function renderBar(props: {
  financialAccountId?: string;
  billingAccountId?: string;
}) {
  return render(
    <TransactionsActionBar
      financialAccountId={props.financialAccountId}
      billingAccountId={props.billingAccountId}
      assignedItems={[]}
      unappliedCashAvailable="0.00"
    />,
  );
}

async function openMenu(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name }));
  return { user, menu: screen.getByRole("menu") };
}

function menuItemTexts(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

describe("TransactionsActionBar — menu composition (ac19-spec §2.2)", () => {
  it("renders exactly three triggers", () => {
    renderBar({ financialAccountId: "fa-1", billingAccountId: "ban-1" });
    expect(screen.getByRole("button", { name: "Payment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Note" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More actions" }),
    ).toBeInTheDocument();
  });

  it("Payment menu lists exactly Capture Payment, Allocate Payment, Payment Refund", async () => {
    renderBar({ financialAccountId: "fa-1", billingAccountId: "ban-1" });
    const { menu } = await openMenu("Payment");
    const texts = menuItemTexts(menu);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe("Capture Payment");
    expect(texts[1]).toBe("Allocate Payment");
    expect(texts[2]).toBe("Payment Refund");
  });

  it("Note menu lists exactly Raise Credit Note, Raise Debit Note", async () => {
    renderBar({ financialAccountId: "fa-1", billingAccountId: "ban-1" });
    const { menu } = await openMenu("Note");
    const texts = menuItemTexts(menu);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe("Raise Credit Note");
    expect(texts[1]).toBe("Raise Debit Note");
  });

  it("More actions menu lists exactly the five deposit/write-off/rounding entries", async () => {
    renderBar({ financialAccountId: "fa-1", billingAccountId: "ban-1" });
    const { menu } = await openMenu("More actions");
    const texts = menuItemTexts(menu);
    expect(texts).toHaveLength(5);
    expect(texts[0]).toBe("Capture Security Deposit");
    expect(texts[1]).toContain("Reverse Deposit to Account");
    expect(texts[1]).toContain(
      "Applies deposit to A/R — not a ledger reversal",
    );
    expect(texts[2]).toBe("Refund Deposit");
    expect(texts[3]).toBe("Write Off");
    expect(texts[4]).toBe("Rounding Adjustment");
  });

  it("Reversal is absent from all three menus (D4/ac22 boundary)", async () => {
    // "Reverse Deposit to Account" legitimately mentions "ledger reversal" in
    // its clarifying description (§2.2) — this checks only entry *labels*
    // (the first span in each item), not the description text, for a
    // standalone "Reversal"-style document-level action.
    function menuItemLabels(menu: HTMLElement): string[] {
      return within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.querySelector("span")?.textContent ?? "");
    }

    renderBar({ financialAccountId: "fa-1", billingAccountId: "ban-1" });
    const { menu: paymentMenu } = await openMenu("Payment");
    expect(menuItemLabels(paymentMenu).join(" ")).not.toMatch(/\bReversal\b/i);
    await userEvent.setup().keyboard("{Escape}");

    const { menu: noteMenu } = await openMenu("Note");
    expect(menuItemLabels(noteMenu).join(" ")).not.toMatch(/\bReversal\b/i);
    await userEvent.setup().keyboard("{Escape}");

    const { menu: moreMenu } = await openMenu("More actions");
    expect(menuItemLabels(moreMenu).join(" ")).not.toMatch(/\bReversal\b/i);
  });
});

describe("TransactionsActionBar — context gating (ac19-spec §2.3)", () => {
  it("with FA only: Capture Payment and the three Deposit entries are enabled", async () => {
    renderBar({ financialAccountId: "fa-1" });
    const { menu } = await openMenu("More actions");
    for (const name of ["Capture Security Deposit", "Refund Deposit"]) {
      const item = within(menu).getByRole("menuitem", { name });
      expect(item).not.toHaveAttribute("aria-disabled", "true");
    }
    const reverseItem = within(menu).getByRole("menuitem", {
      name: /Reverse Deposit to Account/,
    });
    expect(reverseItem).not.toHaveAttribute("aria-disabled", "true");
  });

  it("with FA only: Allocate/Refund/both Notes/Write Off/Rounding are disabled with an explanatory title", async () => {
    renderBar({ financialAccountId: "fa-1" });

    const { menu: paymentMenu } = await openMenu("Payment");
    const capture = within(paymentMenu).getByRole("menuitem", {
      name: "Capture Payment",
    });
    expect(capture).not.toHaveAttribute("aria-disabled", "true");
    const allocate = within(paymentMenu).getByRole("menuitem", {
      name: "Allocate Payment",
    });
    expect(allocate).toHaveAttribute("aria-disabled", "true");
    expect(allocate).toHaveAttribute("title", BAN_MISSING_TITLE);
    const refund = within(paymentMenu).getByRole("menuitem", {
      name: "Payment Refund",
    });
    expect(refund).toHaveAttribute("aria-disabled", "true");
    expect(refund).toHaveAttribute("title", BAN_MISSING_TITLE);
    await userEvent.setup().keyboard("{Escape}");

    const { menu: noteMenu } = await openMenu("Note");
    for (const name of ["Raise Credit Note", "Raise Debit Note"]) {
      const item = within(noteMenu).getByRole("menuitem", { name });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAttribute("title", BAN_MISSING_TITLE);
    }
    await userEvent.setup().keyboard("{Escape}");

    const { menu: moreMenu } = await openMenu("More actions");
    for (const name of ["Write Off", "Rounding Adjustment"]) {
      const item = within(moreMenu).getByRole("menuitem", { name });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(item).toHaveAttribute("title", BAN_MISSING_TITLE);
    }
  });

  it("with FA + BAN: all ten entries are enabled", async () => {
    renderBar({ financialAccountId: "fa-1", billingAccountId: "ban-1" });

    const { menu: paymentMenu } = await openMenu("Payment");
    for (const item of within(paymentMenu).getAllByRole("menuitem")) {
      expect(item).not.toHaveAttribute("aria-disabled", "true");
    }
    await userEvent.setup().keyboard("{Escape}");

    const { menu: noteMenu } = await openMenu("Note");
    for (const item of within(noteMenu).getAllByRole("menuitem")) {
      expect(item).not.toHaveAttribute("aria-disabled", "true");
    }
    await userEvent.setup().keyboard("{Escape}");

    const { menu: moreMenu } = await openMenu("More actions");
    for (const item of within(moreMenu).getAllByRole("menuitem")) {
      expect(item).not.toHaveAttribute("aria-disabled", "true");
    }
  });

  it("with neither FA nor BAN: all three triggers are disabled with an explanatory title", () => {
    renderBar({});
    for (const name of ["Payment", "Note", "More actions"]) {
      const trigger = screen.getByRole("button", { name });
      expect(trigger).toBeDisabled();
      expect(trigger).toHaveAttribute("title", FA_MISSING_TITLE);
    }
  });
});

describe("TransactionsActionBar — dialog shells (ac19-spec §2.4)", () => {
  it("opening Capture Payment renders its distinctive field, and Escape closes the dialog", async () => {
    const user = userEvent.setup();
    renderBar({ financialAccountId: "fa-1", billingAccountId: "ban-1" });

    await user.click(screen.getByRole("button", { name: "Payment" }));
    await user.click(screen.getByRole("menuitem", { name: "Capture Payment" }));

    // level: 2 selects the DialogTitle specifically — the panel's own
    // (untouched, inv. #20) <h3> also renders with the same text, visually
    // suppressed only by production CSS (§2.4), which jsdom doesn't compute.
    expect(
      screen.getByRole("heading", { level: 2, name: "Capture Payment" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Payment Mode")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("TransactionsActionBar — keyboard interaction", () => {
  it("Enter opens the menu and Escape closes it, returning focus to the trigger", async () => {
    const user = userEvent.setup();
    renderBar({ financialAccountId: "fa-1", billingAccountId: "ban-1" });

    const trigger = screen.getByRole("button", { name: "Payment" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
