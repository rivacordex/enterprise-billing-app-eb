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

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { createOfferingAction } from "@/actions/product/create-offering.action";
import { toast } from "sonner";

import { CreateOfferingDialog } from "@/components/products/manage/create-offering-dialog";
import { Button } from "@/components/ui/button";

const mockCreateOfferingAction = vi.mocked(createOfferingAction);
const mockToastSuccess = vi.mocked(toast.success);
const mockToastError = vi.mocked(toast.error);

function renderDialog() {
  return render(
    <CreateOfferingDialog trigger={<Button>New offering</Button>} />,
  );
}

beforeEach(() => {
  mockRefresh.mockReset();
  mockCreateOfferingAction.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

describe("CreateOfferingDialog", () => {
  it("is not visible when closed", () => {
    renderDialog();
    expect(screen.queryByText("New offering")).toBeInTheDocument(); // trigger only
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("clicking the trigger opens the dialog with Sellable checked and Billing only unchecked by default", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "New offering" }));

    expect(
      screen.getByRole("heading", { name: "New offering" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Sellable" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Billing only" }),
    ).not.toBeChecked();
    expect(
      screen.queryByLabelText(/bundle/i, { exact: false }),
    ).not.toBeInTheDocument();
  });

  it("submit with valid values calls createOfferingAction with the exact form values", async () => {
    mockCreateOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000001",
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "New offering" }));
    await user.type(screen.getByLabelText("Name"), "Enterprise Support");
    await user.click(screen.getByRole("checkbox", { name: "Billing only" }));
    await user.click(screen.getByRole("button", { name: "Save offering" }));

    await waitFor(() => {
      expect(mockCreateOfferingAction).toHaveBeenCalledWith({
        name: "Enterprise Support",
        isSellable: true,
        billingOnly: true,
      });
    });
  });

  it("on ok:true closes the dialog, toasts success, and calls router.refresh()", async () => {
    mockCreateOfferingAction.mockResolvedValue({
      ok: true,
      offeringId: "PRDOFR000002",
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "New offering" }));
    await user.type(screen.getByLabelText("Name"), "Basic Plan");
    await user.click(screen.getByRole("button", { name: "Save offering" }));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockToastSuccess).toHaveBeenCalledWith("Offering created");
    await waitFor(() => {
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    });
  });

  it("on FORBIDDEN keeps the dialog open and shows an error toast", async () => {
    mockCreateOfferingAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "New offering" }));
    await user.type(screen.getByLabelText("Name"), "Basic Plan");
    await user.click(screen.getByRole("button", { name: "Save offering" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("on SERVER_ERROR keeps the dialog open and shows an error toast", async () => {
    mockCreateOfferingAction.mockResolvedValue({
      ok: false,
      code: "SERVER_ERROR",
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "New offering" }));
    await user.type(screen.getByLabelText("Name"), "Basic Plan");
    await user.click(screen.getByRole("button", { name: "Save offering" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("submitting with an empty name never calls the action and shows a field-level error", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "New offering" }));
    await user.click(screen.getByRole("button", { name: "Save offering" }));

    expect(
      await screen.findByText("Offering name is required"),
    ).toBeInTheDocument();
    expect(mockCreateOfferingAction).not.toHaveBeenCalled();
  });

  it("Cancel closes the dialog without calling the action", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "New offering" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockCreateOfferingAction).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    });
  });

  it("disables and shows a spinner on the Save offering button while submitting, and blocks dismissal", async () => {
    let resolveAction!: (value: { ok: true; offeringId: string }) => void;
    mockCreateOfferingAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "New offering" }));
    await user.type(screen.getByLabelText("Name"), "Basic Plan");
    await user.click(screen.getByRole("button", { name: "Save offering" }));

    expect(
      screen.getByRole("button", { name: /Save offering/ }),
    ).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Name")).toBeInTheDocument();

    resolveAction({ ok: true, offeringId: "PRDOFR000003" });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
  });
});
