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
import { BillingAccountPanel } from "@/components/customers/billing-account-panel";
import { BIND_FAILURE_MESSAGES } from "@/components/customers/billing-account-messages";
import type {
  BanTemplateLabel,
  BindableTemplateType,
  CustomerBillingAccountRow,
} from "@/types/accounts";

// cm23-spec §3.10 / CM guardrail 13 — the per-BAN type select + Save, the
// failure messages and the next-run caption (custmgmt-ui-context §10.2).
const mockAction = vi.mocked(setBillingAccountTemplateAction);

const LOCK = new Date("2026-01-01T00:00:00.000Z");
const SAVE = "Save";
const SELECT = "Invoice template type";

const STANDARD_LABEL: BanTemplateLabel = {
  kind: "STANDARD",
  text: "Standard (default) · v1",
  name: "Standard (default)",
  versionNo: 1,
};

// listBindableTemplateTypes() output: Standard first, then usable types by
// name. Retired and not-yet-usable types never reach the panel.
const TYPES: BindableTemplateType[] = [
  { typeId: null, name: "Standard (default)" },
  { typeId: "BTF00000003", name: "Government" },
  { typeId: "BTF00000002", name: "Wholesale" },
];

function row(
  overrides: Partial<CustomerBillingAccountRow> = {},
): CustomerBillingAccountRow {
  return {
    billingAccountId: "BAN000001",
    name: "Primary",
    state: "active",
    lastModified: LOCK,
    refBillTemplateFamilyId: null,
    templateLabel: STANDARD_LABEL,
    ...overrides,
  };
}

function renderPanel(
  bans: CustomerBillingAccountRow[],
  canEditAccounts = true,
): ReturnType<typeof render> {
  return render(
    <BillingAccountPanel
      partyRoleId="PTRL00000001"
      accounts={{ onboarded: true, bans }}
      templateTypes={TYPES}
      canEditAccounts={canEditAccounts}
    />,
  );
}

async function choose(item: HTMLElement, name: string): Promise<void> {
  await userEvent.click(within(item).getByRole("combobox", { name: SELECT }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

function banItem(id = "BAN000001"): HTMLElement {
  return screen.getByRole("listitem", { name: `Billing account ${id}` });
}

beforeEach(() => {
  mockAction.mockReset();
  refresh.mockReset();
});

describe("BillingAccountPanel (cm23)", () => {
  it("lists the BAN with id, name, state chip and the type label", () => {
    renderPanel([row()]);

    const item = banItem();
    expect(within(item).getByText("BAN000001")).toBeInTheDocument();
    expect(within(item).getByText("· Primary")).toBeInTheDocument();
    expect(within(item).getByText("Active")).toBeInTheDocument();
    expect(
      within(item).getByLabelText("Standard (default) · v1"),
    ).toBeInTheDocument();
  });

  it("the select lists Standard first, then usable types by name", async () => {
    renderPanel([row()]);

    await userEvent.click(screen.getByRole("combobox", { name: SELECT }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Standard (default)",
      "Government",
      "Wholesale",
    ]);
  });

  it("starts on the BAN's current type, with Save disabled while unchanged", () => {
    renderPanel([row({ refBillTemplateFamilyId: "BTF00000002" })]);

    expect(screen.getByRole("combobox", { name: SELECT })).toHaveTextContent(
      "Wholesale",
    );
    expect(screen.getByRole("button", { name: SAVE })).toBeDisabled();
  });

  it("a different selection enables Save, with no tooltip", async () => {
    renderPanel([row()]);

    await choose(banItem(), "Wholesale");

    const save = screen.getByRole("button", { name: SAVE });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("title");
  });

  it("without accounts_transactions:EDIT → select and Save disabled with the EDIT_DISABLED_TITLE tooltip", () => {
    renderPanel([row()], false);

    const select = screen.getByRole("combobox", { name: SELECT });
    const save = screen.getByRole("button", { name: SAVE });
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("title", EDIT_DISABLED_TITLE);
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title", EDIT_DISABLED_TITLE);
  });

  it("a BAN on a type that isn't usable → 'Choose a type' placeholder and Save disabled until a choice", async () => {
    renderPanel([
      row({
        refBillTemplateFamilyId: "BTF00000009",
        templateLabel: {
          kind: "NOT_USABLE",
          text: "Retail · not usable",
          name: "Retail",
          versionNo: null,
        },
      }),
    ]);

    expect(screen.getByRole("combobox", { name: SELECT })).toHaveTextContent(
      "Choose a type",
    );
    expect(screen.getByRole("button", { name: SAVE })).toBeDisabled();

    await choose(banItem(), "Standard (default)");
    expect(screen.getByRole("button", { name: SAVE })).toBeEnabled();
  });

  it("a closed BAN → 'Billing account is closed' and no select or Save", () => {
    renderPanel([row({ state: "closed" })]);

    expect(screen.getByText("Billing account is closed")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: SAVE })).toBeNull();
  });

  it("shows the next-run caption once, under the panel", () => {
    renderPanel([row(), row({ billingAccountId: "BAN000002" })]);

    expect(
      screen.getAllByText(
        "Changes apply from the next bill run start or rerun.",
      ),
    ).toHaveLength(1);
  });

  it("not onboarded → the onboarding copy and no BAN rows", () => {
    render(
      <BillingAccountPanel
        partyRoleId="PTRL00000001"
        accounts={{ onboarded: false }}
        templateTypes={TYPES}
        canEditAccounts
      />,
    );

    expect(
      screen.getByText("Accounts are created when the customer is validated."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("a failed Accounts read (accounts: null) → the unavailable card and no BAN rows", () => {
    render(
      <BillingAccountPanel
        partyRoleId="PTRL00000001"
        accounts={null}
        templateTypes={[]}
        canEditAccounts
      />,
    );

    expect(
      screen.getByText(/Account details could not be loaded/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("while one save is in flight, every other row's Save is disabled too", async () => {
    let settle!: (value: { ok: false; code: "CONFLICT" }) => void;
    mockAction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    renderPanel([row(), row({ billingAccountId: "BAN000002" })]);
    await choose(banItem("BAN000001"), "Wholesale");
    await choose(banItem("BAN000002"), "Government");
    const first = within(banItem("BAN000001")).getByRole("button", {
      name: SAVE,
    });
    const second = within(banItem("BAN000002")).getByRole("button", {
      name: SAVE,
    });
    expect(second).toBeEnabled();

    await userEvent.click(first);

    expect(second).toBeDisabled();
    settle({ ok: false, code: "CONFLICT" });
    await waitFor(() => expect(second).toBeEnabled());
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it("Save sends typeId and the row's lastModified, and refreshes on success", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: {
        billingAccountId: "BAN000001",
        changed: true,
        lastModified: LOCK,
      },
    });
    renderPanel([row()]);

    await choose(banItem(), "Wholesale");
    await userEvent.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(mockAction).toHaveBeenCalledWith({
      partyRoleId: "PTRL00000001",
      billingAccountId: "BAN000001",
      typeId: "BTF00000002",
      lastModified: LOCK,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("choosing Standard (default) sends typeId: null", async () => {
    mockAction.mockResolvedValue({
      ok: true,
      value: {
        billingAccountId: "BAN000001",
        changed: true,
        lastModified: LOCK,
      },
    });
    renderPanel([
      row({
        refBillTemplateFamilyId: "BTF00000002",
        templateLabel: {
          kind: "TYPE",
          text: "Wholesale · v1",
          name: "Wholesale",
          versionNo: 1,
        },
      }),
    ]);

    await choose(banItem(), "Standard (default)");
    await userEvent.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() =>
      expect(mockAction).toHaveBeenCalledWith(
        expect.objectContaining({ typeId: null }),
      ),
    );
  });

  it("TEMPLATE_NOT_BINDABLE shows the retired-type message and reloads", async () => {
    mockAction.mockResolvedValue({ ok: false, code: "TEMPLATE_NOT_BINDABLE" });
    renderPanel([row()]);

    await choose(banItem(), "Wholesale");
    await userEvent.click(screen.getByRole("button", { name: SAVE }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invoice template type is no longer available. It may have been retired. The account's current type has been reloaded.",
    );
    expect(refresh).toHaveBeenCalled();
  });

  it.each([
    [
      "CONFLICT",
      "This billing account was changed by someone else. Reload and try again.",
    ],
    ["BAN_CLOSED", "This billing account is closed."],
    ["BAN_NOT_FOUND", "Billing account not found. Reload the page."],
    ["FORBIDDEN", "You do not have permission to change billing accounts."],
  ] as const)(
    "%s shows its message in a danger alert, no reload",
    async (code, text) => {
      expect(BIND_FAILURE_MESSAGES[code]).toBe(text);
      mockAction.mockResolvedValue({ ok: false, code });
      renderPanel([row()]);

      await choose(banItem(), "Wholesale");
      await userEvent.click(screen.getByRole("button", { name: SAVE }));

      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(refresh).not.toHaveBeenCalled();
    },
  );
});
