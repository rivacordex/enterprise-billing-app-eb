import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

vi.mock("@/actions/product/delete-offering.action", () => ({
  deleteOfferingAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { deleteOfferingAction } from "@/actions/product/delete-offering.action";
import { toast } from "sonner";

import { DeleteVersionDialog } from "@/components/products/manage/delete-version-dialog";

const mockDeleteOfferingAction = vi.mocked(deleteOfferingAction);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

beforeEach(() => {
  mockPush.mockReset();
  mockRefresh.mockReset();
  mockDeleteOfferingAction.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof DeleteVersionDialog>> = {},
) {
  return render(
    <DeleteVersionDialog
      trigger={<button>Open</button>}
      offeringId="PRDOFR1"
      offeringName="Test Plan"
      offeringVersion={3}
      specificationCount={2}
      priceCount={2}
      query=""
      status={null}
      page={1}
      {...overrides}
    />,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open" }));
}

describe("DeleteVersionDialog", () => {
  it("states the version and the spec/price counts in the copy", async () => {
    const user = userEvent.setup();
    renderDialog({ specificationCount: 2, priceCount: 2 });

    await openDialog(user);

    expect(
      screen.getByText(
        /deletes this version with its 2 specifications and 2 prices/,
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard version" }),
    ).toBeInTheDocument();
  });

  it("on success with a remaining family navigates to the family (no version)", async () => {
    mockDeleteOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      familyId: "PRDOFR9",
      familyRemains: true,
      specificationsRemoved: 2,
      pricesRemoved: 2,
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.type(screen.getByLabelText("Reason (optional)"), "mistake");
    await user.click(screen.getByRole("button", { name: "Discard version" }));

    await waitFor(() => {
      expect(mockDeleteOfferingAction).toHaveBeenCalledWith("PRDOFR1", {
        reason: "mistake",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Version discarded");
    expect(mockPush).toHaveBeenCalledWith(
      "/products/manage-products?family=PRDOFR9",
    );
  });

  it("on success with an emptied family navigates to the bare list", async () => {
    mockDeleteOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR1",
      familyId: "PRDOFR1",
      familyRemains: false,
      specificationsRemoved: 0,
      pricesRemoved: 0,
    });
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Discard version" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/products/manage-products");
    });
  });

  it.each([
    ["FORBIDDEN", "You don't have permission to do that."],
    [
      "OFFERING_NOT_DELETABLE",
      "This version can no longer be discarded. Refreshing...",
    ],
    ["OFFERING_NOT_FOUND", "This offering no longer exists. Refreshing..."],
  ] as const)("on %s shows the matching toast", async (code, message) => {
    mockDeleteOfferingAction.mockResolvedValue(
      code === "OFFERING_NOT_DELETABLE"
        ? { ok: false, code, lifecycleStatus: "ACTIVE" }
        : { ok: false, code },
    );
    const user = userEvent.setup();
    renderDialog();

    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Discard version" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(message);
    });
    expect(mockPush).not.toHaveBeenCalled();
  });
});
