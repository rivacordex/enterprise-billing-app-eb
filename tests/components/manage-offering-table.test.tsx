import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/actions/product/create-offering.action", () => ({
  createOfferingAction: vi.fn(),
}));

vi.mock("@/actions/product/update-offering.action", () => ({
  updateOfferingAction: vi.fn(),
}));

vi.mock("@/actions/product/create-specification.action", () => ({
  createSpecificationAction: vi.fn(),
}));

vi.mock("@/actions/product/update-specification.action", () => ({
  updateSpecificationAction: vi.fn(),
}));

vi.mock("@/actions/product/delete-specification.action", () => ({
  deleteSpecificationAction: vi.fn(),
}));

vi.mock("@/actions/product/insert-price.action", () => ({
  insertPriceAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

import { insertPriceAction } from "@/actions/product/insert-price.action";
import { updateOfferingAction } from "@/actions/product/update-offering.action";
import { ManageOfferingTable } from "@/components/products/manage/manage-offering-table";
import type {
  OfferingFamilyRow,
  OfferingListRow,
  SpecificationCard,
} from "@/types/product";

const mockUpdateOfferingAction = vi.mocked(updateOfferingAction);
const mockInsertPriceAction = vi.mocked(insertPriceAction);
const mockToastSuccess = vi.mocked(toast.success);

function makeRow(overrides: Partial<OfferingListRow>): OfferingListRow {
  return {
    productOfferingId: "PRDOFR000001",
    name: "Offering",
    lifecycleStatus: "ACTIVE",
    version: 1,
    isSellable: true,
    billingOnly: false,
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
    familyOfferingId: null,
    ...overrides,
  };
}

function singleFamily(row: OfferingListRow): OfferingFamilyRow {
  return { familyId: row.productOfferingId, primary: row, versions: [row] };
}

const DEFAULT_PROPS = {
  locale: "en-US",
  timezone: "UTC",
  specificationsByOfferingId: {},
};

beforeEach(() => {
  mockRefresh.mockReset();
  mockUpdateOfferingAction.mockReset();
  mockInsertPriceAction.mockReset();
  mockToastSuccess.mockReset();
});

describe("ManageOfferingTable", () => {
  it("a DRAFT row shows exactly Edit, Add price, Activate, Discard", () => {
    const draft = makeRow({
      productOfferingId: "PRDOFR000001",
      name: "Draft Offering",
      lifecycleStatus: "DRAFT",
    });
    render(
      <ManageOfferingTable
        {...DEFAULT_PROPS}
        families={[singleFamily(draft)]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Edit Draft Offering" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add price to Draft Offering" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Activate Draft Offering" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard Draft Offering" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retire Draft Offering" }),
    ).not.toBeInTheDocument();
  });

  it("an ACTIVE row shows exactly Edit, Add price, Retire", () => {
    const active = makeRow({
      productOfferingId: "PRDOFR000002",
      name: "Active Offering",
      lifecycleStatus: "ACTIVE",
    });
    render(
      <ManageOfferingTable
        {...DEFAULT_PROPS}
        families={[singleFamily(active)]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Edit Active Offering" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add price to Active Offering" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retire Active Offering" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Activate Active Offering" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Discard Active Offering" }),
    ).not.toBeInTheDocument();
  });

  it("a RETIRED row shows no action buttons, only muted 'No actions — retired' text", () => {
    const retired = makeRow({
      productOfferingId: "PRDOFR000003",
      name: "Retired Offering",
      lifecycleStatus: "RETIRED",
    });
    render(
      <ManageOfferingTable
        {...DEFAULT_PROPS}
        families={[singleFamily(retired)]}
      />,
    );

    expect(screen.getByText("No actions — retired")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Retired Offering/ }),
    ).not.toBeInTheDocument();
  });

  it("a single-version family renders no expand chevron", () => {
    const row = makeRow({
      productOfferingId: "PRDOFR000004",
      name: "Solo Offering",
    });
    render(
      <ManageOfferingTable {...DEFAULT_PROPS} families={[singleFamily(row)]} />,
    );

    expect(
      screen.queryByRole("button", { name: /other versions of Solo Offering/ }),
    ).not.toBeInTheDocument();
  });

  it("expanding a multi-version family reveals every version with its own independent action set", async () => {
    const activePrimary = makeRow({
      productOfferingId: "PRDOFR000005",
      name: "Multi Offering",
      familyOfferingId: null,
      version: 2,
      lifecycleStatus: "ACTIVE",
    });
    const draftSibling = makeRow({
      productOfferingId: "PRDOFR000006",
      name: "Multi Offering",
      familyOfferingId: "PRDOFR000005",
      version: 1,
      lifecycleStatus: "DRAFT",
    });
    const family: OfferingFamilyRow = {
      familyId: "PRDOFR000005",
      primary: activePrimary,
      versions: [activePrimary, draftSibling],
    };

    const user = userEvent.setup();
    render(<ManageOfferingTable {...DEFAULT_PROPS} families={[family]} />);

    const chevron = screen.getByRole("button", {
      name: "Show other versions of Multi Offering",
    });
    expect(chevron).toBeInTheDocument();
    expect(chevron).toHaveAttribute("aria-expanded", "false");

    // Only the primary's action set is visible before expanding.
    expect(
      screen.getByRole("button", { name: "Retire Multi Offering" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Activate Multi Offering" }),
    ).not.toBeInTheDocument();

    await user.click(chevron);

    expect(
      screen.getByRole("button", {
        name: "Hide other versions of Multi Offering",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    // Expanded state re-renders every version including the primary (pm18-spec
    // §3.7 point 5), so the ACTIVE primary's action set appears twice: once
    // in the primary summary row, once in its own expanded sub-row.
    expect(
      screen.getAllByRole("button", { name: "Retire Multi Offering" }),
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Activate Multi Offering" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard Multi Offering" }),
    ).toBeInTheDocument();
  });

  it("renders a focusable 'New offering' CTA and every remaining row-action seam, still wired to nothing (pm19-spec §3.7)", async () => {
    const draft = makeRow({
      productOfferingId: "PRDOFR000007",
      name: "Seam Offering",
      lifecycleStatus: "DRAFT",
    });
    const user = userEvent.setup();
    render(
      <ManageOfferingTable
        {...DEFAULT_PROPS}
        families={[singleFamily(draft)]}
      />,
    );

    const cta = screen.getByRole("button", { name: "New offering" });
    expect(cta).toBeInTheDocument();

    // Row-action seams (Activate/Discard) remain real seams for pm23 —
    // clicking them still produces no dialog and no observable DOM change.
    // Edit is excluded from this loop as of pm20, Specifications as of
    // pm21, and Add price as of pm22: all three now open real dialogs
    // (covered by the "Edit offering", "Specifications", and "Add price"
    // suites below).
    const editButton = screen.getByRole("button", {
      name: "Edit Seam Offering",
    });
    const specsButton = screen.getByRole("button", {
      name: "Manage specifications for Seam Offering",
    });
    const addPriceButton = screen.getByRole("button", {
      name: "Add price to Seam Offering",
    });
    const rowActionButtons = screen
      .getAllByRole("button")
      .filter(
        (button) =>
          button !== cta &&
          button !== editButton &&
          button !== specsButton &&
          button !== addPriceButton,
      );
    for (const button of rowActionButtons) {
      await user.click(button);
    }

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editButton).toBeInTheDocument();
    expect(specsButton).toBeInTheDocument();
  });

  it("clicking the 'New offering' CTA opens CreateOfferingDialog (pm19-spec §3.5)", async () => {
    const draft = makeRow({
      productOfferingId: "PRDOFR000008",
      name: "Another Offering",
      lifecycleStatus: "DRAFT",
    });
    const user = userEvent.setup();
    render(
      <ManageOfferingTable
        {...DEFAULT_PROPS}
        families={[singleFamily(draft)]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New offering" }));

    expect(
      screen.getByRole("heading", { name: "New offering" }),
    ).toBeInTheDocument();
  });

  describe("Edit offering (pm20-spec §3.8)", () => {
    it("clicking Edit on a DRAFT row opens 'Edit draft' prefilled, no banner, three footer buttons", async () => {
      const draft = makeRow({
        productOfferingId: "PRDOFR000009",
        name: "Draft Row",
        lifecycleStatus: "DRAFT",
        isSellable: true,
        billingOnly: true,
      });
      const user = userEvent.setup();
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(draft)]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Edit Draft Row" }));

      expect(
        screen.getByRole("heading", { name: "Edit draft" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Name")).toHaveValue("Draft Row");
      expect(screen.getByRole("checkbox", { name: "Sellable" })).toBeChecked();
      expect(
        screen.getByRole("checkbox", { name: "Billing only" }),
      ).toBeChecked();
      expect(screen.queryByText(/is active\. Saving will not/)).toBeNull();
      expect(
        screen.getByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save as new draft" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Create new draft" }),
      ).not.toBeInTheDocument();
    });

    it("clicking Edit on an ACTIVE row opens 'Edit — creates new draft' with the warning banner and exactly two footer buttons", async () => {
      const active = makeRow({
        productOfferingId: "PRDOFR000010",
        name: "Active Row",
        lifecycleStatus: "ACTIVE",
      });
      const user = userEvent.setup();
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(active)]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Edit Active Row" }));

      expect(
        screen.getByRole("heading", { name: "Edit — creates new draft" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Active Row is active. Saving will not change it — a new draft version is created instead.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Create new draft" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save as new draft" }),
      ).not.toBeInTheDocument();
    });

    it("clicking 'Save' on a DRAFT submits saveAsNew: false, closes the dialog, and toasts 'Offering updated'", async () => {
      mockUpdateOfferingAction.mockResolvedValue({
        ok: true,
        offeringId: "PRDOFR000011",
        branched: false,
      });
      const draft = makeRow({
        productOfferingId: "PRDOFR000011",
        name: "Save Row",
        lifecycleStatus: "DRAFT",
      });
      const user = userEvent.setup();
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(draft)]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Edit Save Row" }));
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateOfferingAction).toHaveBeenCalledWith(
          "PRDOFR000011",
          expect.objectContaining({ saveAsNew: false }),
        );
      });
      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith("Offering updated");
      });
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("clicking 'Save as new draft' on a DRAFT submits saveAsNew: true, toasts 'New draft version created', and auto-expands the family", async () => {
      mockUpdateOfferingAction.mockResolvedValue({
        ok: true,
        offeringId: "PRDOFR000013",
        branched: true,
      });
      const primary = makeRow({
        productOfferingId: "PRDOFR000012",
        name: "Branch Row",
        familyOfferingId: null,
        version: 1,
        lifecycleStatus: "DRAFT",
      });
      const sibling = makeRow({
        productOfferingId: "PRDOFR000013",
        name: "Branch Row",
        familyOfferingId: "PRDOFR000012",
        version: 2,
        lifecycleStatus: "DRAFT",
      });
      const family: OfferingFamilyRow = {
        familyId: "PRDOFR000012",
        primary,
        versions: [sibling, primary],
      };
      const user = userEvent.setup();
      render(<ManageOfferingTable {...DEFAULT_PROPS} families={[family]} />);

      // The sibling isn't visible until the family expands.
      expect(
        screen.queryByRole("button", {
          name: "Hide other versions of Branch Row",
        }),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Edit Branch Row" }));
      await user.click(
        screen.getByRole("button", { name: "Save as new draft" }),
      );

      await waitFor(() => {
        expect(mockUpdateOfferingAction).toHaveBeenCalledWith(
          "PRDOFR000012",
          expect.objectContaining({ saveAsNew: true }),
        );
      });
      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith(
          "New draft version created",
        );
      });
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", {
          name: "Hide other versions of Branch Row",
        }),
      ).toBeInTheDocument();
    });

    it("clicking an expanded sibling's own Edit button populates the dialog with the sibling's values and submits the sibling's id", async () => {
      mockUpdateOfferingAction.mockResolvedValue({
        ok: true,
        offeringId: "PRDOFR000017",
        branched: false,
      });
      const primary = makeRow({
        productOfferingId: "PRDOFR000016",
        name: "Primary Row",
        familyOfferingId: null,
        version: 2,
        lifecycleStatus: "DRAFT",
        isSellable: true,
        billingOnly: false,
      });
      const sibling = makeRow({
        productOfferingId: "PRDOFR000017",
        name: "Sibling Row",
        familyOfferingId: "PRDOFR000016",
        version: 1,
        lifecycleStatus: "DRAFT",
        isSellable: false,
        billingOnly: true,
      });
      const family: OfferingFamilyRow = {
        familyId: "PRDOFR000016",
        primary,
        versions: [primary, sibling],
      };
      const user = userEvent.setup();
      render(<ManageOfferingTable {...DEFAULT_PROPS} families={[family]} />);

      await user.click(
        screen.getByRole("button", {
          name: "Show other versions of Primary Row",
        }),
      );
      await user.click(
        screen.getByRole("button", { name: "Edit Sibling Row" }),
      );

      expect(screen.getByLabelText("Name")).toHaveValue("Sibling Row");
      expect(
        screen.getByRole("checkbox", { name: "Sellable" }),
      ).not.toBeChecked();
      expect(
        screen.getByRole("checkbox", { name: "Billing only" }),
      ).toBeChecked();

      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(mockUpdateOfferingAction).toHaveBeenCalledWith(
          "PRDOFR000017",
          expect.objectContaining({ saveAsNew: false }),
        );
      });
    });

    it("clicking 'Create new draft' on an ACTIVE row submits saveAsNew: true and toasts 'New draft version created'", async () => {
      mockUpdateOfferingAction.mockResolvedValue({
        ok: true,
        offeringId: "PRDOFR000015",
        branched: true,
      });
      const active = makeRow({
        productOfferingId: "PRDOFR000014",
        name: "Active Branch Row",
        lifecycleStatus: "ACTIVE",
      });
      const user = userEvent.setup();
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(active)]}
        />,
      );

      await user.click(
        screen.getByRole("button", { name: "Edit Active Branch Row" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Create new draft" }),
      );

      await waitFor(() => {
        expect(mockUpdateOfferingAction).toHaveBeenCalledWith(
          "PRDOFR000014",
          expect.objectContaining({ saveAsNew: true }),
        );
      });
      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith(
          "New draft version created",
        );
      });
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("Cancel closes the dialog without submitting", async () => {
      const draft = makeRow({
        productOfferingId: "PRDOFR000016",
        name: "Cancel Row",
        lifecycleStatus: "DRAFT",
      });
      const user = userEvent.setup();
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(draft)]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Edit Cancel Row" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(mockUpdateOfferingAction).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("Specifications (pm21-spec §3.11)", () => {
    function makeSpec(
      overrides: Partial<SpecificationCard>,
    ): SpecificationCard {
      return {
        productSpecId: "PRDSPC000001",
        name: "Color",
        isMandatory: false,
        isDefault: false,
        defaultValue: null,
        characteristics: {},
        ...overrides,
      };
    }

    it("no Specifications button renders on a RETIRED row", () => {
      const retired = makeRow({
        productOfferingId: "PRDOFR000017",
        name: "Retired Specs Row",
        lifecycleStatus: "RETIRED",
      });
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(retired)]}
        />,
      );

      expect(
        screen.queryByRole("button", {
          name: "Manage specifications for Retired Specs Row",
        }),
      ).not.toBeInTheDocument();
    });

    it("clicking Specifications on a DRAFT row opens SpecificationsDialog titled 'Specifications — <name>'", async () => {
      const draft = makeRow({
        productOfferingId: "PRDOFR000018",
        name: "Specs Draft Row",
        lifecycleStatus: "DRAFT",
      });
      const user = userEvent.setup();
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(draft)]}
        />,
      );

      await user.click(
        screen.getByRole("button", {
          name: "Manage specifications for Specs Draft Row",
        }),
      );

      expect(
        screen.getByRole("heading", {
          name: "Specifications — Specs Draft Row",
        }),
      ).toBeInTheDocument();
    });

    it("clicking Specifications on an ACTIVE row opens the same dialog", async () => {
      const active = makeRow({
        productOfferingId: "PRDOFR000019",
        name: "Specs Active Row",
        lifecycleStatus: "ACTIVE",
      });
      const user = userEvent.setup();
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(active)]}
          specificationsByOfferingId={{
            PRDOFR000019: [makeSpec({ name: "Color" })],
          }}
        />,
      );

      await user.click(
        screen.getByRole("button", {
          name: "Manage specifications for Specs Active Row",
        }),
      );

      expect(
        screen.getByRole("heading", {
          name: "Specifications — Specs Active Row",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("Color")).toBeInTheDocument();
    });

    it("opens Specifications from an expanded sibling row too", async () => {
      const primary = makeRow({
        productOfferingId: "PRDOFR000020",
        name: "Specs Family",
        familyOfferingId: null,
        version: 2,
        lifecycleStatus: "ACTIVE",
      });
      const sibling = makeRow({
        productOfferingId: "PRDOFR000021",
        name: "Specs Family",
        familyOfferingId: "PRDOFR000020",
        version: 1,
        lifecycleStatus: "DRAFT",
      });
      const family: OfferingFamilyRow = {
        familyId: "PRDOFR000020",
        primary,
        versions: [primary, sibling],
      };
      const user = userEvent.setup();
      render(<ManageOfferingTable {...DEFAULT_PROPS} families={[family]} />);

      await user.click(
        screen.getByRole("button", {
          name: "Show other versions of Specs Family",
        }),
      );
      const specsButtons = screen.getAllByRole("button", {
        name: "Manage specifications for Specs Family",
      });
      // Primary summary row + its own expanded sub-row (same shape as the
      // Retire-button assertion above), so the sibling's own button is the
      // third match.
      await user.click(specsButtons[2]!);

      expect(
        screen.getByRole("heading", { name: "Specifications — Specs Family" }),
      ).toBeInTheDocument();
    });
  });

  describe("Add price (pm22-spec §3.7)", () => {
    it("clicking Add price on a DRAFT row (primary or an expanded sibling) opens AddPriceDialog", async () => {
      const draft = makeRow({
        productOfferingId: "PRDOFR000022",
        name: "Price Draft Row",
        lifecycleStatus: "DRAFT",
      });
      const user = userEvent.setup();
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(draft)]}
        />,
      );

      await user.click(
        screen.getByRole("button", { name: "Add price to Price Draft Row" }),
      );

      expect(
        screen.getByRole("heading", { name: "Add price — Price Draft Row" }),
      ).toBeInTheDocument();
    });

    it("clicking Add price on an ACTIVE row opens the dialog titled 'Add price — creates new draft — <Name>'", async () => {
      const active = makeRow({
        productOfferingId: "PRDOFR000023",
        name: "Price Active Row",
        lifecycleStatus: "ACTIVE",
      });
      const user = userEvent.setup();
      render(
        <ManageOfferingTable
          {...DEFAULT_PROPS}
          families={[singleFamily(active)]}
        />,
      );

      await user.click(
        screen.getByRole("button", { name: "Add price to Price Active Row" }),
      );

      expect(
        screen.getByRole("heading", {
          name: "Add price — creates new draft — Price Active Row",
        }),
      ).toBeInTheDocument();
    });

    it("opens Add price from an expanded sibling row too", async () => {
      const primary = makeRow({
        productOfferingId: "PRDOFR000024",
        name: "Price Family",
        familyOfferingId: null,
        version: 2,
        lifecycleStatus: "ACTIVE",
      });
      const sibling = makeRow({
        productOfferingId: "PRDOFR000025",
        name: "Price Family",
        familyOfferingId: "PRDOFR000024",
        version: 1,
        lifecycleStatus: "DRAFT",
      });
      const family: OfferingFamilyRow = {
        familyId: "PRDOFR000024",
        primary,
        versions: [primary, sibling],
      };
      const user = userEvent.setup();
      render(<ManageOfferingTable {...DEFAULT_PROPS} families={[family]} />);

      await user.click(
        screen.getByRole("button", {
          name: "Show other versions of Price Family",
        }),
      );
      const addPriceButtons = screen.getAllByRole("button", {
        name: "Add price to Price Family",
      });
      // Primary summary row + its own expanded sub-row, so the sibling's
      // own button is the third match (same shape as the Retire/Specs
      // assertions above).
      await user.click(addPriceButtons[2]!);

      expect(
        screen.getByRole("heading", { name: "Add price — Price Family" }),
      ).toBeInTheDocument();
    });

    it("a successful branched Add price result adds the family id to expandedFamilies, making the sibling visible", async () => {
      mockInsertPriceAction.mockResolvedValue({
        ok: true,
        offeringId: "PRDOFR000027",
        productOfferingPriceId: "PRDPRC000001",
        branched: true,
        backdated: false,
      });
      const primary = makeRow({
        productOfferingId: "PRDOFR000026",
        name: "Price Branch Row",
        familyOfferingId: null,
        version: 2,
        lifecycleStatus: "ACTIVE",
      });
      const sibling = makeRow({
        productOfferingId: "PRDOFR000027",
        name: "Price Branch Row",
        familyOfferingId: "PRDOFR000026",
        version: 1,
        lifecycleStatus: "DRAFT",
      });
      const family: OfferingFamilyRow = {
        familyId: "PRDOFR000026",
        primary,
        versions: [primary, sibling],
      };
      const user = userEvent.setup();
      render(<ManageOfferingTable {...DEFAULT_PROPS} families={[family]} />);

      expect(
        screen.queryByRole("button", {
          name: "Hide other versions of Price Branch Row",
        }),
      ).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Add price to Price Branch Row" }),
      );
      await user.type(screen.getByLabelText("Price name"), "Monthly");
      await user.type(screen.getByLabelText("Currency"), "USD");
      await user.type(screen.getByLabelText("Amount"), "10.00");
      const buttons = screen.getAllByRole("button", { name: "Add price" });
      await user.click(buttons[buttons.length - 1]!);

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith(
          "Price added to new draft version",
        );
      });
      await waitFor(() => {
        expect(
          screen.getByRole("button", {
            name: "Hide other versions of Price Branch Row",
          }),
        ).toBeInTheDocument();
      });
    });
  });
});
