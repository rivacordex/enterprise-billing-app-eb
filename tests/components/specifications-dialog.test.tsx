import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
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

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { createSpecificationAction } from "@/actions/product/create-specification.action";
import { deleteSpecificationAction } from "@/actions/product/delete-specification.action";
import { updateSpecificationAction } from "@/actions/product/update-specification.action";
import { SpecificationsDialog } from "@/components/products/manage/specifications-dialog";
import { toast } from "sonner";
import type { SpecificationCard } from "@/types/product";

const mockCreate = vi.mocked(createSpecificationAction);
const mockUpdate = vi.mocked(updateSpecificationAction);
const mockDelete = vi.mocked(deleteSpecificationAction);
const mockToastSuccess = vi.mocked(toast.success);

const OFFERING_ID = "PRDOFR000001";
const FAMILY_ID = "PRDOFR000001";

function makeSpec(overrides: Partial<SpecificationCard>): SpecificationCard {
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

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof SpecificationsDialog>> = {},
) {
  const onOpenChange = vi.fn();
  const onBranch = vi.fn();
  const utils = render(
    <SpecificationsDialog
      offeringId={OFFERING_ID}
      offeringName="Enterprise Support"
      offeringStatus="DRAFT"
      familyId={FAMILY_ID}
      specifications={[]}
      isOpen
      onOpenChange={onOpenChange}
      onBranch={onBranch}
      {...overrides}
    />,
  );
  return { onOpenChange, onBranch, ...utils };
}

beforeEach(() => {
  mockRefresh.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();
  mockToastSuccess.mockReset();
});

describe("SpecificationsDialog", () => {
  it("a DRAFT-target row shows both Edit and Delete buttons, no warning banner", () => {
    renderDialog({
      offeringStatus: "DRAFT",
      specifications: [makeSpec({ name: "Color" })],
    });

    expect(
      screen.getByRole("button", { name: "Edit Color" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete Color" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/is active\. Adding or editing/)).toBeNull();
  });

  it("an ACTIVE-target row shows Edit only, and shows the warning banner", () => {
    renderDialog({
      offeringStatus: "ACTIVE",
      specifications: [makeSpec({ name: "Color" })],
    });

    expect(
      screen.getByRole("button", { name: "Edit Color" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete Color" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Enterprise Support is active. Adding or editing a specification here creates a new draft version instead.",
      ),
    ).toBeInTheDocument();
  });

  it("clicking 'Add specification' switches to the form view with mode create", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Add specification" }));

    expect(
      screen.getByRole("heading", { name: "Add specification" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("a successful direct (branched: false) create stays open, toasts, and refreshes", async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: "PRDSPC000002",
      branched: false,
    });
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Add specification" }));
    await user.type(screen.getByLabelText("Name"), "Color");
    await user.click(screen.getByRole("button", { name: "Add specification" }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("Specification added");
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mockRefresh).toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        name: "Specifications — Enterprise Support",
      }),
    ).toBeInTheDocument();
  });

  it("a successful branch-producing (branched: true) create closes, toasts, calls onBranch, and refreshes", async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000002",
      productSpecId: "PRDSPC000003",
      branched: true,
    });
    const user = userEvent.setup();
    const { onOpenChange, onBranch } = renderDialog({
      offeringStatus: "ACTIVE",
    });

    await user.click(screen.getByRole("button", { name: "Add specification" }));
    await user.type(screen.getByLabelText("Name"), "Color");
    await user.click(screen.getByRole("button", { name: "Add specification" }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(onBranch).toHaveBeenCalledWith(FAMILY_ID);
    expect(mockToastSuccess).toHaveBeenCalledWith("New draft version created");
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("a successful direct update stays open and toasts 'Specification updated'", async () => {
    const spec = makeSpec({ name: "Color" });
    mockUpdate.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: spec.productSpecId,
      branched: false,
    });
    const user = userEvent.setup();
    renderDialog({ specifications: [spec] });

    await user.click(screen.getByRole("button", { name: "Edit Color" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        spec.productSpecId,
        OFFERING_ID,
        expect.objectContaining({ name: "Color" }),
      );
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("Specification updated");
    });
  });

  it("clicking Delete opens the nested AlertDialog naming the target spec", async () => {
    const spec = makeSpec({ name: "Color" });
    const user = userEvent.setup();
    renderDialog({ specifications: [spec] });

    await user.click(screen.getByRole("button", { name: "Delete Color" }));

    expect(
      screen.getByRole("alertdialog", { name: "Delete specification" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/permanently delete the specification/),
    ).toBeInTheDocument();
  });

  it("confirming delete calls deleteSpecificationAction with (productSpecId, offeringId), stays open, and toasts", async () => {
    const spec = makeSpec({ name: "Color" });
    mockDelete.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: spec.productSpecId,
      branched: false,
    });
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ specifications: [spec] });

    await user.click(screen.getByRole("button", { name: "Delete Color" }));
    await user.click(
      screen.getByRole("button", { name: "Delete specification" }),
    );

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(spec.productSpecId, OFFERING_ID);
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("Specification deleted");
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
