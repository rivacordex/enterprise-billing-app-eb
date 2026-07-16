import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("@/actions/customer/add-contact", () => ({
  addContactAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { addContactAction } from "@/actions/customer/add-contact";
import { ContactManagerPanel } from "@/components/customers/contact-manager-panel";
import type { ContactRow } from "@/types/customer";

const mockAddContactAction = vi.mocked(addContactAction);

const LOCK = new Date("2026-01-01T00:00:00.000Z");

const NAME_ONLY_CONTACT: ContactRow = {
  contactMediumId: "CTMD00000001",
  contactName: "Jane Doe",
  contactRole: null,
  phoneNumber: null,
  emailAddress: null,
  address: null,
  preferredMethod: null,
  isPreferredContact: true,
};

beforeEach(() => {
  refreshMock.mockReset();
  mockAddContactAction.mockReset();
});

describe("ContactManagerPanel", () => {
  it("renders a name-only contact with the reused 'No contact method on file' state", () => {
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[NAME_ONLY_CONTACT]}
        lastModifiedDatetime={LOCK}
      />,
    );

    expect(screen.getByText("No contact method on file")).toBeInTheDocument();
  });

  it("the add-contact form's fields match contactFieldsSchema and a name-only submission succeeds", async () => {
    mockAddContactAction.mockResolvedValueOnce({
      ok: true,
      value: {
        contactMediumId: "CTMD00000002",
        lastModifiedDatetime: new Date("2026-01-01T00:00:01.000Z"),
      },
    });

    const user = userEvent.setup();
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[]}
        lastModifiedDatetime={LOCK}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add contact" }));

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Role")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Address Line 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Address Line 2")).toBeInTheDocument();
    expect(screen.getByLabelText("City")).toBeInTheDocument();
    expect(screen.getByLabelText("State / Province")).toBeInTheDocument();
    expect(screen.getByLabelText("Postal Code")).toBeInTheDocument();
    expect(screen.getByLabelText("Country")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "Jane Doe");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockAddContactAction).toHaveBeenCalledWith(
        expect.objectContaining({
          partyRoleId: "PTRL00000001",
          lastModifiedDatetime: LOCK,
          contactName: "Jane Doe",
          phoneNumber: null,
          emailAddress: null,
          addressLine1: null,
        }),
      ),
    );
  });

  it("a CONFLICT result shows the reload-prompt banner", async () => {
    mockAddContactAction.mockResolvedValueOnce({
      ok: false,
      code: "CONFLICT",
    });

    const user = userEvent.setup();
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[]}
        lastModifiedDatetime={LOCK}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add contact" }));
    await user.type(screen.getByLabelText("Name"), "Jane Doe");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "This customer was changed by someone else. Reload to see the latest version.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(refreshMock).toHaveBeenCalled();
  });
});
