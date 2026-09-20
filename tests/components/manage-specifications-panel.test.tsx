import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// pm41 I6 (+ review fixes). ManageSpecificationsPanel stays a server component;
// its editable client leaf (EditableSpecifications) is exercised here. The three
// spec actions and next/navigation + sonner are mocked so the assertions are
// about the panel's own behaviour (one row at a time, dirty-discard prompt,
// explicit save, navigate-on-branch, typed-result handling).
const mockRefresh = vi.fn();
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: mockPush }),
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
import { ManageSpecificationsPanel } from "@/components/products/manage/manage-specifications-panel";
import type { SpecificationCard } from "@/types/product";

const mockCreate = vi.mocked(createSpecificationAction);
const mockUpdate = vi.mocked(updateSpecificationAction);
const mockDelete = vi.mocked(deleteSpecificationAction);

const OFFERING_ID = "PRDOFR000001";
const FAMILY_ID = "PRDOFR000001";

function makeSpec(overrides: Partial<SpecificationCard>): SpecificationCard {
  return {
    productSpecId: "PRDSMD00000001",
    name: "Bandwidth",
    isMandatory: true,
    isDefault: false,
    defaultValue: null,
    characteristics: {},
    ...overrides,
  };
}

function renderPanel(
  canEdit: boolean,
  specifications: SpecificationCard[],
): void {
  render(
    <ManageSpecificationsPanel
      canEdit={canEdit}
      offeringId={OFFERING_ID}
      specifications={specifications}
      familyId={FAMILY_ID}
      query=""
      status={null}
      page={1}
    />,
  );
}

beforeEach(() => {
  mockRefresh.mockReset();
  mockPush.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();
});

describe("ManageSpecificationsPanel", () => {
  it("edit → save calls updateSpecificationAction and refreshes", async () => {
    mockUpdate.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: "PRDSMD00000001",
      branched: false,
    });
    const user = userEvent.setup();
    renderPanel(true, [makeSpec({ name: "Bandwidth" })]);

    await user.click(screen.getByRole("button", { name: /^Edit Bandwidth/ }));
    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Downstream");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "PRDSMD00000001",
        OFFERING_ID,
        expect.objectContaining({ name: "Downstream" }),
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("a VALIDATION_ERROR keeps the row in edit mode with the field message", async () => {
    mockUpdate.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { name: ["Name already taken"] },
    });
    const user = userEvent.setup();
    renderPanel(true, [makeSpec({ name: "Bandwidth" })]);

    await user.click(screen.getByRole("button", { name: /^Edit Bandwidth/ }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Downstream");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Server field error is attached to the Name field (aria-invalid) — review #7.
    await waitFor(() => {
      expect(screen.getByText("Name already taken")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("delete confirms inline, calls deleteSpecificationAction and refreshes", async () => {
    mockDelete.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: "PRDSMD00000001",
      branched: false,
    });
    const user = userEvent.setup();
    renderPanel(true, [makeSpec({ name: "Bandwidth" })]);

    await user.click(screen.getByRole("button", { name: /^Delete Bandwidth/ }));
    expect(screen.getByText("Delete this specification?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("PRDSMD00000001", OFFERING_ID);
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("add appends: the add form calls createSpecificationAction", async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      offeringId: OFFERING_ID,
      productSpecId: "PRDSMD00000002",
      branched: false,
    });
    const user = userEvent.setup();
    renderPanel(true, []);

    await user.click(screen.getByRole("button", { name: "Add specification" }));
    await user.type(screen.getByLabelText("Name"), "Latency");
    await user.click(screen.getByRole("button", { name: "Add specification" }));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        OFFERING_ID,
        expect.objectContaining({ name: "Latency" }),
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("only one row is editable at a time", async () => {
    const user = userEvent.setup();
    renderPanel(true, [
      makeSpec({ productSpecId: "PRDSMD00000001", name: "Spec A" }),
      makeSpec({ productSpecId: "PRDSMD00000002", name: "Spec B" }),
    ]);

    await user.click(screen.getByRole("button", { name: /^Edit Spec A/ }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Edit Spec B/ }));

    // Spec A's editor closed (its Edit trigger is back); Spec B's is open.
    expect(
      screen.getByRole("button", { name: /^Edit Spec A/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Edit Spec B/ }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Name")).toHaveLength(1);
  });

  it("activating a second row while the first is dirty prompts to discard (review #4/#5)", async () => {
    const user = userEvent.setup();
    renderPanel(true, [
      makeSpec({ productSpecId: "PRDSMD00000001", name: "Spec A" }),
      makeSpec({ productSpecId: "PRDSMD00000002", name: "Spec B" }),
    ]);

    await user.click(screen.getByRole("button", { name: /^Edit Spec A/ }));
    await user.type(screen.getByLabelText("Name"), "X"); // make it dirty
    await user.click(screen.getByRole("button", { name: /^Edit Spec B/ }));

    // Discard prompt shows; A stays open until resolved.
    expect(
      screen.getByText("Discard unsaved changes to this specification?"),
    ).toBeInTheDocument();

    // Keep editing dismisses the prompt without switching.
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(
      screen.queryByText("Discard unsaved changes to this specification?"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Spec AX");

    // Re-request, then Discard switches to Spec B's fresh (unmodified) editor.
    await user.click(screen.getByRole("button", { name: /^Edit Spec B/ }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(
      screen.getByRole("button", { name: /^Edit Spec A/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Spec B");
  });

  it("a mid-edit ACTIVE race that branches navigates to the new draft (review #2)", async () => {
    mockUpdate.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000009",
      productSpecId: "PRDSMD00000001",
      branched: true,
    });
    const user = userEvent.setup();
    renderPanel(true, [makeSpec({ name: "Bandwidth" })]);

    await user.click(screen.getByRole("button", { name: /^Edit Bandwidth/ }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Downstream");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        expect.stringContaining("version=PRDOFR000009"),
      );
    });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("renders no editing controls when canEdit is false", () => {
    renderPanel(false, [makeSpec({ name: "Bandwidth" })]);

    expect(screen.getByText("Bandwidth")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add specification" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Edit Bandwidth/ }),
    ).not.toBeInTheDocument();
  });
});
