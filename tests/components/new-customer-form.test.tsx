import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/actions/customer/create-customer", () => ({
  createCustomerAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { createCustomerAction } from "@/actions/customer/create-customer";
import { NewCustomerForm } from "@/components/customers/new-customer-form";

const mockCreateCustomerAction = vi.mocked(createCustomerAction);

async function fillName(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  const input = screen.getByLabelText("Name");
  await user.clear(input);
  await user.type(input, name);
}

beforeEach(() => {
  pushMock.mockReset();
  mockCreateCustomerAction.mockReset();
});

describe("NewCustomerForm", () => {
  it("shows the similar-name warning and relabels the button 'Create anyway' after a SIMILAR_NAMES_FOUND result", async () => {
    mockCreateCustomerAction.mockResolvedValueOnce({
      ok: false,
      code: "SIMILAR_NAMES_FOUND",
      similarNames: ["Acme Corporation"],
    });

    const user = userEvent.setup();
    render(<NewCustomerForm />);

    await fillName(user, "Acme Corp");
    await user.click(screen.getByRole("button", { name: "Create customer" }));

    expect(
      await screen.findByText("Similar customers already exist:"),
    ).toBeInTheDocument();
    expect(screen.getByText("Acme Corporation")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create anyway" }),
    ).toBeInTheDocument();

    expect(mockCreateCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: false }),
    );
  });

  it("resubmitting after the warning sends confirmed: true and does not re-trigger the check", async () => {
    mockCreateCustomerAction
      .mockResolvedValueOnce({
        ok: false,
        code: "SIMILAR_NAMES_FOUND",
        similarNames: ["Acme Corporation"],
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { organizationId: "ORG0000001", partyRoleId: "PTRL00000001" },
      });

    const user = userEvent.setup();
    render(<NewCustomerForm />);

    await fillName(user, "Acme Corp");
    await user.click(screen.getByRole("button", { name: "Create customer" }));
    await screen.findByRole("button", { name: "Create anyway" });

    await user.click(screen.getByRole("button", { name: "Create anyway" }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/customers/manage/PTRL00000001"),
    );

    expect(mockCreateCustomerAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ confirmed: true }),
    );
  });

  it("editing the name after a warning resets the button label and clears the warning", async () => {
    mockCreateCustomerAction.mockResolvedValueOnce({
      ok: false,
      code: "SIMILAR_NAMES_FOUND",
      similarNames: ["Acme Corporation"],
    });

    const user = userEvent.setup();
    render(<NewCustomerForm />);

    await fillName(user, "Acme Corp");
    await user.click(screen.getByRole("button", { name: "Create customer" }));
    await screen.findByRole("button", { name: "Create anyway" });

    await user.type(screen.getByLabelText("Name"), " Renamed");

    expect(
      screen.queryByText("Similar customers already exist:"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create customer" }),
    ).toBeInTheDocument();
  });

  it("surfaces DUPLICATE_REGISTRATION_NUMBER as a field-level error on Registration Number, not a toast", async () => {
    mockCreateCustomerAction.mockResolvedValueOnce({
      ok: false,
      code: "DUPLICATE_REGISTRATION_NUMBER",
    });

    const user = userEvent.setup();
    render(<NewCustomerForm />);

    await fillName(user, "Acme Corp");
    await user.click(screen.getByRole("button", { name: "Create customer" }));

    expect(
      await screen.findByText("This registration number is already in use."),
    ).toBeInTheDocument();
  });
});
