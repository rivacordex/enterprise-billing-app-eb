import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/actions/accounts/set-billing-account-template", () => ({
  setBillingAccountTemplateAction: vi.fn(),
}));

import { setBillingAccountTemplateAction } from "@/actions/accounts/set-billing-account-template";
import { EDIT_DISABLED_TITLE } from "@/components/accounts/edit-access";
import {
  BillingAccountPanel,
  RESET_FAILURE_MESSAGES,
} from "@/components/customers/billing-account-panel";
import type { CustomerBillingAccountRow } from "@/types/accounts";

// cm21-spec §2 table / §3.7 — the reset control's enabled/disabled states and
// the failure messages (custmgmt-ui-context §9.5).
const mockAction = vi.mocked(setBillingAccountTemplateAction);

const LOCK = new Date("2026-01-01T00:00:00.000Z");
const RESET = "Reset to follow active template";

function row(
  overrides: Partial<CustomerBillingAccountRow> = {},
): CustomerBillingAccountRow {
  return {
    billingAccountId: "BAN000001",
    name: "Primary",
    state: "active",
    lastModified: LOCK,
    refBillTemplateVersionId: null,
    templateLabel:
      "Follows active template (currently: INVTPL-STD-A4 v1), as of now",
    ...overrides,
  };
}

function renderPanel(ban: CustomerBillingAccountRow, canEditAccounts = true) {
  return render(
    <BillingAccountPanel
      partyRoleId="PTRL00000001"
      accounts={{ onboarded: true, bans: [ban] }}
      canEditAccounts={canEditAccounts}
    />,
  );
}

beforeEach(() => {
  mockAction.mockReset();
  refresh.mockReset();
});

describe("BillingAccountPanel (cm21)", () => {
  it("lists the BAN with id, name, state chip and template label", () => {
    renderPanel(row());

    const item = screen.getByRole("listitem", {
      name: "Billing account BAN000001",
    });
    expect(within(item).getByText("BAN000001")).toBeInTheDocument();
    expect(within(item).getByText("· Primary")).toBeInTheDocument();
    expect(within(item).getByText("Active")).toBeInTheDocument();
    expect(item).toHaveTextContent(
      "Follows active template (currently: INVTPL-STD-A4 v1), as of now",
    );
  });

  it("a NULL BAN → disabled with 'Already following the active template'", () => {
    renderPanel(row());

    expect(screen.getByRole("button", { name: RESET })).toBeDisabled();
    expect(
      screen.getByText("Already following the active template"),
    ).toBeInTheDocument();
  });

  it("a non-NULL BAN with the permission → enabled, no tooltip", () => {
    renderPanel(row({ refBillTemplateVersionId: "BTV00000002" }));

    const button = screen.getByRole("button", { name: RESET });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("title");
  });

  it("without accounts_transactions:EDIT → disabled with the EDIT_DISABLED_TITLE tooltip", () => {
    renderPanel(row({ refBillTemplateVersionId: "BTV00000002" }), false);

    const button = screen.getByRole("button", { name: RESET });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", EDIT_DISABLED_TITLE);
  });

  it("a closed BAN → disabled with 'Billing account is closed'", () => {
    renderPanel(
      row({ state: "closed", refBillTemplateVersionId: "BTV00000002" }),
    );

    expect(screen.getByRole("button", { name: RESET })).toBeDisabled();
    expect(screen.getByText("Billing account is closed")).toBeInTheDocument();
  });

  it("not onboarded → the onboarding copy and no BAN rows", () => {
    render(
      <BillingAccountPanel
        partyRoleId="PTRL00000001"
        accounts={{ onboarded: false }}
        canEditAccounts
      />,
    );

    expect(
      screen.getByText("Accounts are created when the customer is validated."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByRole("button", { name: RESET })).toBeNull();
  });

  it("a failed Accounts read (accounts: null) → the unavailable card and no BAN rows", () => {
    render(
      <BillingAccountPanel
        partyRoleId="PTRL00000001"
        accounts={null}
        canEditAccounts
      />,
    );

    expect(
      screen.getByText(/Account details could not be loaded/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("while one reset is in flight, every other row's reset is disabled too", async () => {
    let settle!: (value: { ok: false; code: "CONFLICT" }) => void;
    mockAction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(
      <BillingAccountPanel
        partyRoleId="PTRL00000001"
        accounts={{
          onboarded: true,
          bans: [
            row({ refBillTemplateVersionId: "BTV00000002" }),
            row({
              billingAccountId: "BAN000002",
              refBillTemplateVersionId: "BTV00000002",
            }),
          ],
        }}
        canEditAccounts
      />,
    );
    const first = within(
      screen.getByRole("listitem", { name: "Billing account BAN000001" }),
    ).getByRole("button", { name: RESET });
    const second = within(
      screen.getByRole("listitem", { name: "Billing account BAN000002" }),
    ).getByRole("button", { name: RESET });

    await userEvent.click(first);

    expect(second).toBeDisabled();
    settle({ ok: false, code: "CONFLICT" });
    await waitFor(() => expect(second).toBeEnabled());
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it("a click sends billTemplateVersionId: null with the row's lastModified and refreshes on success", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: {
        billingAccountId: "BAN000001",
        changed: true,
        lastModified: LOCK,
      },
    });
    renderPanel(row({ refBillTemplateVersionId: "BTV00000002" }));

    await userEvent.click(screen.getByRole("button", { name: RESET }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(mockAction).toHaveBeenCalledWith({
      partyRoleId: "PTRL00000001",
      billingAccountId: "BAN000001",
      billTemplateVersionId: null,
      lastModified: LOCK,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [
      "CONFLICT",
      "This billing account was changed by someone else. Reload and try again.",
    ],
    ["BAN_CLOSED", "This billing account is closed."],
    ["TEMPLATE_NOT_BINDABLE", "This invoice template cannot be assigned."],
    ["BAN_NOT_FOUND", "Billing account not found. Reload the page."],
    ["FORBIDDEN", "You do not have permission to change billing accounts."],
  ] as const)("%s shows its message in a danger alert", async (code, text) => {
    expect(RESET_FAILURE_MESSAGES[code]).toBe(text);
    mockAction.mockResolvedValue({ ok: false, code });
    renderPanel(row({ refBillTemplateVersionId: "BTV00000002" }));

    await userEvent.click(screen.getByRole("button", { name: RESET }));

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(refresh).not.toHaveBeenCalled();
  });
});
