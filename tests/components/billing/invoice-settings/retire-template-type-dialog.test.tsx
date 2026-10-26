// bm83-spec §8 — `RetireTemplateTypeDialog` (ui-context §10e): the bound-BAN
// count and paginated list ("Show more" reads the next page through the
// action), the target select with Standard first and preselected (`null`),
// the confirm disabled until the exact typed name (after trim), the danger
// role on the confirm inside the dialog only, and each refusal's message
// followed by a refresh.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock(
  "@/actions/billing/invoice-settings/retire-template-type.action",
  () => ({ retireTemplateTypeAction: vi.fn() }),
);
vi.mock("@/actions/billing/invoice-settings/list-bound-bans.action", () => ({
  listBoundBansAction: vi.fn(),
}));

import { toast } from "sonner";

import { listBoundBansAction } from "@/actions/billing/invoice-settings/list-bound-bans.action";
import { retireTemplateTypeAction } from "@/actions/billing/invoice-settings/retire-template-type.action";
import {
  RetireTemplateTypeDialog,
  type RetireTemplateTypeDialogProps,
} from "@/components/billing/invoice-settings/retire-template-type-dialog";
import { TEMPLATE_TYPE_MESSAGES } from "@/components/billing/invoice-settings/template-type-messages";

const mockRetire = vi.mocked(retireTemplateTypeAction);
const mockList = vi.mocked(listBoundBansAction);

const FIRST = [
  { billingAccountId: "BAN00000001", name: "Acme Wholesale", state: "active" },
  { billingAccountId: "BAN00000002", name: "Beta Trading", state: "closed" },
];
const SECOND = [
  { billingAccountId: "BAN00000003", name: "Gamma Ltd", state: "active" },
];

function renderDialog(
  overrides: Partial<RetireTemplateTypeDialogProps> = {},
): void {
  render(
    <RetireTemplateTypeDialog
      typeId="BTF00000002"
      typeName="Wholesale"
      boundBanCount={3}
      firstBoundBans={FIRST}
      retireTargets={[{ billTemplateFamilyId: "BTF00000003", name: "Retail" }]}
      {...overrides}
    />,
  );
}

function openDialog(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Retire type…" }));
  return screen.getByRole("alertdialog");
}

function confirmButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("button", { name: "Retire type" });
}

function typeName(dialog: HTMLElement, value: string): void {
  fireEvent.change(
    within(dialog).getByLabelText(TEMPLATE_TYPE_MESSAGES.retireNameLabel),
    { target: { value } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RetireTemplateTypeDialog (bm83)", () => {
  it("shows the bound-BAN count and the first page of BANs (mono ids, name, state)", () => {
    renderDialog();
    const dialog = openDialog();
    const count = within(dialog).getByTestId("retire-bound-ban-count");
    expect(count).toHaveTextContent("3");
    expect(count.className).toContain("text-h3");
    expect(count.className).toContain("tabular-nums");
    const list = within(dialog).getByRole("list", {
      name: "Bound billing accounts",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const id = within(items[0]!).getByText("BAN00000001");
    expect(id.className).toContain("font-mono");
    expect(items[1]).toHaveTextContent("Beta Trading");
    expect(items[1]).toHaveTextContent("closed");
  });

  it("Show more reads the next page through the action and appends it; it disappears once every BAN is listed", async () => {
    mockList.mockResolvedValue({ ok: true, rows: SECOND });
    renderDialog();
    const dialog = openDialog();
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Show more" }),
      );
    });
    expect(mockList).toHaveBeenCalledWith({ typeId: "BTF00000002", page: 1 });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
    expect(within(dialog).getByText("BAN00000003")).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Show more" }),
    ).toBeNull();
  });

  it("a type with no bound BANs says so and offers no Show more", () => {
    renderDialog({ boundBanCount: 0, firstBoundBans: [] });
    const dialog = openDialog();
    expect(
      within(dialog).getByText(TEMPLATE_TYPE_MESSAGES.retireNoBoundBans),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: "Show more" }),
    ).toBeNull();
  });

  it("preselects Standard and lists it first, then the usable targets", () => {
    renderDialog();
    const dialog = openDialog();
    const select = within(dialog).getByRole("combobox");
    expect(select).toHaveTextContent("Standard (default)");
    fireEvent.click(select);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Standard (default)",
      "Retail",
    ]);
  });

  it("keeps the confirm disabled until the exact name is typed (after trim)", () => {
    renderDialog();
    const dialog = openDialog();
    expect(confirmButton(dialog)).toBeDisabled();
    typeName(dialog, "wholesale");
    expect(confirmButton(dialog)).toBeDisabled();
    typeName(dialog, "Wholesal");
    expect(confirmButton(dialog)).toBeDisabled();
    typeName(dialog, "  Wholesale ");
    expect(confirmButton(dialog)).toBeEnabled();
  });

  it("uses the danger role on the confirm inside the dialog only; the page trigger is an outline button", () => {
    renderDialog();
    const trigger = screen.getByRole("button", { name: "Retire type…" });
    expect(trigger.className).not.toContain("text-destructive");
    expect(trigger.className).toContain("border-border");
    const dialog = openDialog();
    expect(confirmButton(dialog).className).toContain("text-destructive");
  });

  it("retires to Standard (null), toasts the moved count and refreshes", async () => {
    mockRetire.mockResolvedValue({ ok: true, movedBanCount: 3 });
    renderDialog();
    const dialog = openDialog();
    typeName(dialog, "Wholesale");
    await act(async () => {
      fireEvent.click(confirmButton(dialog));
    });
    expect(mockRetire).toHaveBeenCalledWith({
      typeId: "BTF00000002",
      targetTypeId: null,
      confirmName: "Wholesale",
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Wholesale retired. 3 billing accounts moved to Standard (default).",
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("says '1 billing account' when one moved (review fix)", async () => {
    mockRetire.mockResolvedValue({ ok: true, movedBanCount: 1 });
    renderDialog();
    const dialog = openDialog();
    typeName(dialog, "Wholesale");
    await act(async () => {
      fireEvent.click(confirmButton(dialog));
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Wholesale retired. 1 billing account moved to Standard (default).",
    );
  });

  it("retires to a chosen usable type by its id", async () => {
    mockRetire.mockResolvedValue({ ok: true, movedBanCount: 3 });
    renderDialog();
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Retail" }));
    typeName(dialog, "Wholesale");
    await act(async () => {
      fireEvent.click(confirmButton(dialog));
    });
    expect(mockRetire).toHaveBeenCalledWith(
      expect.objectContaining({ targetTypeId: "BTF00000003" }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Wholesale retired. 3 billing accounts moved to Retail.",
    );
  });

  it.each([
    ["TEMPLATE_TYPE_RETIRED", TEMPLATE_TYPE_MESSAGES.retireAlreadyRetired],
    [
      "DEFAULT_TYPE_NOT_RETIRABLE",
      TEMPLATE_TYPE_MESSAGES.retireDefaultNotRetirable,
    ],
    ["RETIRE_TARGET_NOT_USABLE", TEMPLATE_TYPE_MESSAGES.retireTargetNotUsable],
    ["RETIRE_NAME_MISMATCH", TEMPLATE_TYPE_MESSAGES.retireNameMismatch],
    ["FORBIDDEN", TEMPLATE_TYPE_MESSAGES.retireForbidden],
    ["SERVER_ERROR", TEMPLATE_TYPE_MESSAGES.retireFailed],
  ] as const)(
    "a %s refusal shows its message, then refreshes",
    async (code, message) => {
      mockRetire.mockResolvedValue({ ok: false, code });
      renderDialog();
      const dialog = openDialog();
      typeName(dialog, "Wholesale");
      await act(async () => {
        fireEvent.click(confirmButton(dialog));
      });
      expect(toast.error).toHaveBeenCalledWith(message);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it("a refused retirement leaves no stale typed name or target when reopened", async () => {
    mockRetire.mockResolvedValue({
      ok: false,
      code: "RETIRE_TARGET_NOT_USABLE",
    });
    renderDialog();
    const first = openDialog();
    fireEvent.click(within(first).getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Retail" }));
    typeName(first, "Wholesale");
    await act(async () => {
      fireEvent.click(confirmButton(first));
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();

    const reopened = openDialog();
    expect(
      within(reopened).getByLabelText(TEMPLATE_TYPE_MESSAGES.retireNameLabel),
    ).toHaveValue("");
    expect(within(reopened).getByRole("combobox")).toHaveTextContent(
      "Standard (default)",
    );
    expect(confirmButton(reopened)).toBeDisabled();
  });

  // Review fixes (bm83–84) — OFFSET paging over a live set, and props that a
  // refresh replaces between openings.
  it("a row that shifted onto the next page is listed once", async () => {
    mockList.mockResolvedValue({
      ok: true,
      rows: [FIRST[1]!, ...SECOND],
    });
    renderDialog();
    const dialog = openDialog();
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Show more" }),
      );
    });
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => within(li).getByText(/^BAN/).textContent),
    ).toEqual(["BAN00000001", "BAN00000002", "BAN00000003"]);
  });

  it("an empty next page hides Show more even when the count says there are more", async () => {
    mockList.mockResolvedValue({ ok: true, rows: [] });
    renderDialog({ boundBanCount: 25 });
    const dialog = openDialog();
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Show more" }),
      );
    });
    expect(
      within(dialog).queryByRole("button", { name: "Show more" }),
    ).toBeNull();
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
  });

  it("each opening lists from the current props, not the list of an earlier opening", async () => {
    mockList.mockResolvedValue({ ok: true, rows: SECOND });
    const props = {
      typeId: "BTF00000002",
      typeName: "Wholesale",
      retireTargets: [],
    };
    const { rerender } = render(
      <RetireTemplateTypeDialog
        {...props}
        boundBanCount={3}
        firstBoundBans={FIRST}
      />,
    );
    const first = openDialog();
    await act(async () => {
      fireEvent.click(within(first).getByRole("button", { name: "Show more" }));
    });
    expect(within(first).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));

    // A refresh: one BAN left, still unlisted pages.
    rerender(
      <RetireTemplateTypeDialog
        {...props}
        boundBanCount={1}
        firstBoundBans={[FIRST[0]!]}
      />,
    );
    const reopened = openDialog();
    expect(within(reopened).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(reopened).getByTestId("retire-bound-ban-count"),
    ).toHaveTextContent("1");
    expect(
      within(reopened).queryByRole("button", { name: "Show more" }),
    ).toBeNull();
  });
});
