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

vi.mock("@/actions/customer/update-contact", () => ({
  updateContactAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { addContactAction } from "@/actions/customer/add-contact";
import { updateContactAction } from "@/actions/customer/update-contact";
import { ContactManagerPanel } from "@/components/customers/contact-manager-panel";
import type { ContactRow } from "@/types/customer";

const mockAddContactAction = vi.mocked(addContactAction);
const mockUpdateContactAction = vi.mocked(updateContactAction);

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

const CONTACT_WITH_PREFERRED_PHONE: ContactRow = {
  contactMediumId: "CTMD00000002",
  contactName: "John Roe",
  contactRole: null,
  phoneNumber: "555-1000",
  emailAddress: "john@example.com",
  address: null,
  preferredMethod: "PHONE",
  isPreferredContact: false,
};

beforeEach(() => {
  refreshMock.mockReset();
  mockAddContactAction.mockReset();
  mockUpdateContactAction.mockReset();
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

  it("editing a contact and clearing its preferred method while another is populated shows the inline block message", async () => {
    mockUpdateContactAction.mockResolvedValueOnce({
      ok: false,
      code: "PREFERRED_METHOD_STILL_POPULATED",
    });

    const user = userEvent.setup();
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[CONTACT_WITH_PREFERRED_PHONE]}
        lastModifiedDatetime={LOCK}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Phone"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Set a different preferred method before clearing this one.",
      ),
    ).toBeInTheDocument();

    expect(mockUpdateContactAction).toHaveBeenCalledWith(
      expect.objectContaining({
        contactMediumId: "CTMD00000002",
        partyRoleId: "PTRL00000001",
        phoneNumber: null,
        emailAddress: "john@example.com",
      }),
    );
  });

  it("a successful contact edit updates the card and does not disturb the preferred-contact pointer", async () => {
    mockUpdateContactAction.mockResolvedValueOnce({
      ok: true,
      value: { lastModifiedDatetime: new Date("2026-01-01T00:00:01.000Z") },
    });

    const user = userEvent.setup();
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[CONTACT_WITH_PREFERRED_PHONE]}
        lastModifiedDatetime={LOCK}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "John Updated");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockUpdateContactAction).toHaveBeenCalledWith(
        expect.objectContaining({
          contactMediumId: "CTMD00000002",
          contactName: "John Updated",
          lastModifiedDatetime: LOCK,
        }),
      ),
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it("a CONFLICT result from an edit shows the reload-prompt banner", async () => {
    mockUpdateContactAction.mockResolvedValueOnce({
      ok: false,
      code: "CONFLICT",
    });

    const user = userEvent.setup();
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[CONTACT_WITH_PREFERRED_PHONE]}
        lastModifiedDatetime={LOCK}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "This customer was changed by someone else. Reload to see the latest version.",
      ),
    ).toBeInTheDocument();
  });
});
