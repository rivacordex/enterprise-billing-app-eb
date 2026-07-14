import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("@/actions/customer/update-organization", () => ({
  updateOrganizationAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { updateOrganizationAction } from "@/actions/customer/update-organization";
import { OrganizationForm } from "@/components/customers/organization-form";
import type { OrganizationDetail } from "@/types/customer";

const mockUpdateOrganizationAction = vi.mocked(updateOrganizationAction);

const ORGANIZATION: OrganizationDetail = {
  organizationId: "ORG0000001",
  name: "Acme Corp",
  tradingName: null,
  organizationType: "COMPANY",
  registrationNumber: "REG-123",
  taxId: null,
  industry: null,
  status: "REGISTERED",
  statusReason: null,
  lastModifiedByName: "Acting Manager",
  lastModifiedDatetime: new Date("2026-01-01T00:00:00.000Z"),
};

beforeEach(() => {
  refreshMock.mockReset();
  mockUpdateOrganizationAction.mockReset();
});

describe("OrganizationForm", () => {
  it("submits valid changes with all fields plus the hidden organizationId/partyRoleId/lastModifiedDatetime unchanged", async () => {
    mockUpdateOrganizationAction.mockResolvedValueOnce({
      ok: true,
      value: { lastModifiedDatetime: new Date("2026-01-01T00:00:01.000Z") },
    });

    const user = userEvent.setup();
    render(
      <OrganizationForm
        organization={ORGANIZATION}
        partyRoleId="PTRL00000001"
        lastModifiedDatetime={ORGANIZATION.lastModifiedDatetime}
      />,
    );

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Acme Corporation");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(mockUpdateOrganizationAction).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "ORG0000001",
          partyRoleId: "PTRL00000001",
          lastModifiedDatetime: ORGANIZATION.lastModifiedDatetime,
          name: "Acme Corporation",
        }),
      ),
    );
  });

  it("a CONFLICT result shows the reload-prompt banner and disables further submission", async () => {
    mockUpdateOrganizationAction.mockResolvedValueOnce({
      ok: false,
      code: "CONFLICT",
    });

    const user = userEvent.setup();
    render(
      <OrganizationForm
        organization={ORGANIZATION}
        partyRoleId="PTRL00000001"
        lastModifiedDatetime={ORGANIZATION.lastModifiedDatetime}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        "This customer was changed by someone else. Reload to see the latest version.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("surfaces DUPLICATE_REGISTRATION_NUMBER as a field-level error on Registration Number, not a toast", async () => {
    mockUpdateOrganizationAction.mockResolvedValueOnce({
      ok: false,
      code: "DUPLICATE_REGISTRATION_NUMBER",
    });

    const user = userEvent.setup();
    render(
      <OrganizationForm
        organization={ORGANIZATION}
        partyRoleId="PTRL00000001"
        lastModifiedDatetime={ORGANIZATION.lastModifiedDatetime}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("This registration number is already in use."),
    ).toBeInTheDocument();
  });
});
