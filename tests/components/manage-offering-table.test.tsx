import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/actions/product/create-offering.action", () => ({
  createOfferingAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ManageOfferingTable } from "@/components/products/manage/manage-offering-table";
import type { OfferingFamilyRow, OfferingListRow } from "@/types/product";

function makeRow(overrides: Partial<OfferingListRow>): OfferingListRow {
  return {
    productOfferingId: "PRDOFR000001",
    name: "Offering",
    lifecycleStatus: "ACTIVE",
    version: 1,
    isSellable: true,
    lastModified: new Date("2026-01-01T00:00:00.000Z"),
    familyOfferingId: null,
    ...overrides,
  };
}

function singleFamily(row: OfferingListRow): OfferingFamilyRow {
  return { familyId: row.productOfferingId, primary: row, versions: [row] };
}

const DEFAULT_PROPS = { locale: "en-US", timezone: "UTC" };

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

  it("renders a focusable 'New offering' CTA and every row action, row actions still wired to nothing (pm19-spec §3.7)", async () => {
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

    // Row-action seams (Edit/Add price/Activate/Discard/Retire) remain real
    // seams for pm20–pm23 — clicking them still produces no dialog and no
    // observable DOM change. The CTA itself is excluded from this loop since
    // it is no longer a no-op as of this unit (see the next test).
    const rowActionButtons = screen
      .getAllByRole("button")
      .filter((button) => button !== cta);
    for (const button of rowActionButtons) {
      await user.click(button);
    }

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Seam Offering" }),
    ).toBeInTheDocument();
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
});
