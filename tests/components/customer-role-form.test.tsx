import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("@/actions/customer/transition-customer-status", () => ({
  transitionCustomerStatusAction: vi.fn(),
}));

vi.mock("@/actions/customer/update-party-role-specification", () => ({
  updatePartyRoleSpecificationAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { transitionCustomerStatusAction } from "@/actions/customer/transition-customer-status";
import { updatePartyRoleSpecificationAction } from "@/actions/customer/update-party-role-specification";
import { CustomerRoleForm } from "@/components/customers/customer-role-form";
import type { CustomerRoleDetail } from "@/types/customer";

const mockTransitionCustomerStatusAction = vi.mocked(
  transitionCustomerStatusAction,
);
const mockUpdatePartyRoleSpecificationAction = vi.mocked(
  updatePartyRoleSpecificationAction,
);

const CUSTOMER_ROLE: CustomerRoleDetail = {
  partyRoleId: "PTRL00000001",
  status: "INITIALIZED",
  statusReason: null,
  specification: { CUST_TYPE: "enterprise" },
  account: null,
  preferredContactId: null,
  lastModifiedByName: "Acting Manager",
  lastModifiedDatetime: new Date("2026-01-01T00:00:00.000Z"),
};

beforeEach(() => {
  refreshMock.mockReset();
  mockTransitionCustomerStatusAction.mockReset();
  mockUpdatePartyRoleSpecificationAction.mockReset();
});

describe("CustomerRoleForm", () => {
  it("submits the status area independently — the specification action is never called", async () => {
    mockTransitionCustomerStatusAction.mockResolvedValueOnce({
      ok: true,
      value: { lastModifiedDatetime: new Date("2026-01-01T00:00:01.000Z") },
    });

    const user = userEvent.setup();
    render(
      <CustomerRoleForm
        customerRole={CUSTOMER_ROLE}
        locale="en-US"
        timezone="UTC"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Validated" }));
    await user.type(screen.getByLabelText("Reason"), "Validation complete.");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(mockTransitionCustomerStatusAction).toHaveBeenCalledWith(
      expect.objectContaining({
        partyRoleId: "PTRL00000001",
        targetStatus: "VALIDATED",
        statusReason: "Validation complete.",
      }),
    );
    expect(mockUpdatePartyRoleSpecificationAction).not.toHaveBeenCalled();
  });

  it("submits the specification area independently — the status action is never called", async () => {
    mockUpdatePartyRoleSpecificationAction.mockResolvedValueOnce({
      ok: true,
      value: { lastModifiedDatetime: new Date("2026-01-01T00:00:01.000Z") },
    });

    const user = userEvent.setup();
    render(
      <CustomerRoleForm
        customerRole={CUSTOMER_ROLE}
        locale="en-US"
        timezone="UTC"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Save specification" }),
    );

    expect(mockUpdatePartyRoleSpecificationAction).toHaveBeenCalledWith(
      expect.objectContaining({ partyRoleId: "PTRL00000001" }),
    );
    expect(mockTransitionCustomerStatusAction).not.toHaveBeenCalled();
  });

  it("a CONFLICT in the status area shows the banner scoped to that area only", async () => {
    mockTransitionCustomerStatusAction.mockResolvedValueOnce({
      ok: false,
      code: "CONFLICT",
    });

    const user = userEvent.setup();
    render(
      <CustomerRoleForm
        customerRole={CUSTOMER_ROLE}
        locale="en-US"
        timezone="UTC"
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Validated" }));
    await user.type(screen.getByLabelText("Reason"), "Validation complete.");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(
      await screen.findByText(
        "This customer was changed by someone else. Reload to see the latest version.",
      ),
    ).toBeInTheDocument();

    // The specification area is untouched by the status area's conflict.
    expect(
      screen.getByLabelText("Party role specification (JSON)"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save specification" }),
    ).toBeInTheDocument();
  });

  it("a CONFLICT in the specification area shows the banner scoped to that area only", async () => {
    mockUpdatePartyRoleSpecificationAction.mockResolvedValueOnce({
      ok: false,
      code: "CONFLICT",
    });

    const user = userEvent.setup();
    render(
      <CustomerRoleForm
        customerRole={CUSTOMER_ROLE}
        locale="en-US"
        timezone="UTC"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Save specification" }),
    );

    const banners = await screen.findAllByText(
      "This customer was changed by someone else. Reload to see the latest version.",
    );
    expect(banners).toHaveLength(1);

    // The status area is untouched by the specification area's conflict.
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
