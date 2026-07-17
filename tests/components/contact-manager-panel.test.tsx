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

vi.mock("@/actions/customer/delete-contact", () => ({
  deleteContactAction: vi.fn(),
}));

vi.mock("@/actions/customer/set-preferred-contact", () => ({
  setPreferredContactAction: vi.fn(),
}));

vi.mock("@/actions/customer/set-preferred-contact-method", () => ({
  setPreferredContactMethodAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { addContactAction } from "@/actions/customer/add-contact";
import { deleteContactAction } from "@/actions/customer/delete-contact";
import { setPreferredContactAction } from "@/actions/customer/set-preferred-contact";
import { setPreferredContactMethodAction } from "@/actions/customer/set-preferred-contact-method";
import { updateContactAction } from "@/actions/customer/update-contact";
import { ContactManagerPanel } from "@/components/customers/contact-manager-panel";
import type { ContactRow } from "@/types/customer";

const mockAddContactAction = vi.mocked(addContactAction);
const mockUpdateContactAction = vi.mocked(updateContactAction);
const mockDeleteContactAction = vi.mocked(deleteContactAction);
const mockSetPreferredContactAction = vi.mocked(setPreferredContactAction);
const mockSetPreferredContactMethodAction = vi.mocked(
  setPreferredContactMethodAction,
);

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
  mockDeleteContactAction.mockReset();
  mockSetPreferredContactAction.mockReset();
  mockSetPreferredContactMethodAction.mockReset();
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

  it("the preferred contact renders no Delete affordance and shows the explanatory caption", () => {
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[NAME_ONLY_CONTACT]}
        lastModifiedDatetime={LOCK}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /^Delete /i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Make another contact preferred to delete this one"),
    ).toBeInTheDocument();
  });

  it("a non-preferred contact's Delete button opens a confirm dialog, and confirming calls deleteContactAction", async () => {
    mockDeleteContactAction.mockResolvedValueOnce({
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

    await user.click(screen.getByRole("button", { name: "Delete John Roe" }));

    expect(screen.getByText("Delete John Roe?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(mockDeleteContactAction).toHaveBeenCalledWith({
        contactMediumId: "CTMD00000002",
        partyRoleId: "PTRL00000001",
        lastModifiedDatetime: LOCK,
      }),
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it("Cancel in the confirm dialog does not call deleteContactAction", async () => {
    const user = userEvent.setup();
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[CONTACT_WITH_PREFERRED_PHONE]}
        lastModifiedDatetime={LOCK}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete John Roe" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Delete John Roe?")).not.toBeInTheDocument();
    expect(mockDeleteContactAction).not.toHaveBeenCalled();
  });

  it("a CONFLICT result from a delete shows the reload-prompt banner", async () => {
    mockDeleteContactAction.mockResolvedValueOnce({
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

    await user.click(screen.getByRole("button", { name: "Delete John Roe" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText(
        "This customer was changed by someone else. Reload to see the latest version.",
      ),
    ).toBeInTheDocument();
  });

  it("'Make preferred' renders only on non-preferred contacts", () => {
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[NAME_ONLY_CONTACT, CONTACT_WITH_PREFERRED_PHONE]}
        lastModifiedDatetime={LOCK}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "Make preferred" }),
    ).toHaveLength(1);
  });

  it("clicking 'Make preferred' calls setPreferredContactAction and refreshes on success", async () => {
    mockSetPreferredContactAction.mockResolvedValueOnce({
      ok: true,
      value: { lastModifiedDatetime: new Date("2026-01-01T00:00:01.000Z") },
    });

    const user = userEvent.setup();
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[NAME_ONLY_CONTACT, CONTACT_WITH_PREFERRED_PHONE]}
        lastModifiedDatetime={LOCK}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Make preferred" }));

    await waitFor(() =>
      expect(mockSetPreferredContactAction).toHaveBeenCalledWith({
        contactMediumId: "CTMD00000002",
        partyRoleId: "PTRL00000001",
        lastModifiedDatetime: LOCK,
      }),
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it("disables all 'Make preferred' buttons while a preferred-contact request is pending", async () => {
    let resolvePending: (value: {
      ok: true;
      value: { lastModifiedDatetime: Date };
    }) => void = () => {};
    const pendingPromise = new Promise<{
      ok: true;
      value: { lastModifiedDatetime: Date };
    }>((resolve) => {
      resolvePending = resolve;
    });

    mockSetPreferredContactAction.mockReturnValueOnce(pendingPromise);

    const secondContact: ContactRow = {
      ...CONTACT_WITH_PREFERRED_PHONE,
      contactMediumId: "CTMD00000003",
      contactName: "Jill May",
      phoneNumber: null,
      emailAddress: "jill@example.com",
      preferredMethod: "EMAIL",
      isPreferredContact: false,
    };

    const user = userEvent.setup();
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[CONTACT_WITH_PREFERRED_PHONE, secondContact]}
        lastModifiedDatetime={LOCK}
      />,
    );

    const buttons = screen.getAllByRole("button", { name: "Make preferred" });
    expect(buttons).toHaveLength(2);

    await user.click(buttons[0]!);

    await waitFor(() => {
      screen
        .getAllByRole("button", { name: "Make preferred" })
        .forEach((button) => expect(button).toBeDisabled());
    });

    resolvePending({
      ok: true,
      value: { lastModifiedDatetime: new Date("2026-01-01T00:00:01.000Z") },
    });

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it("a CONFLICT result from 'Make preferred' shows the reload-prompt banner", async () => {
    mockSetPreferredContactAction.mockResolvedValueOnce({
      ok: false,
      code: "CONFLICT",
    });

    const user = userEvent.setup();
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[NAME_ONLY_CONTACT, CONTACT_WITH_PREFERRED_PHONE]}
        lastModifiedDatetime={LOCK}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Make preferred" }));

    expect(
      await screen.findByText(
        "This customer was changed by someone else. Reload to see the latest version.",
      ),
    ).toBeInTheDocument();
  });

  it("a method-row 'Make preferred' button appears only on populated, non-preferred method rows", () => {
    render(
      <ContactManagerPanel
        partyRoleId="PTRL00000001"
        contacts={[CONTACT_WITH_PREFERRED_PHONE]}
        lastModifiedDatetime={LOCK}
      />,
    );

    // Phone is already the preferred method (shows PreferredIndicator, no button).
    expect(
      screen.queryByRole("button", { name: "Make phone preferred" }),
    ).not.toBeInTheDocument();
    // Email is populated and not preferred.
    expect(
      screen.getByRole("button", { name: "Make email preferred" }),
    ).toBeInTheDocument();
    // Address is unpopulated on this contact.
    expect(
      screen.queryByRole("button", { name: "Make address preferred" }),
    ).not.toBeInTheDocument();
  });

  it("clicking a method-row 'Make preferred' button calls setPreferredContactMethodAction and refreshes on success", async () => {
    mockSetPreferredContactMethodAction.mockResolvedValueOnce({
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

    await user.click(
      screen.getByRole("button", { name: "Make email preferred" }),
    );

    await waitFor(() =>
      expect(mockSetPreferredContactMethodAction).toHaveBeenCalledWith({
        contactMediumId: "CTMD00000002",
        partyRoleId: "PTRL00000001",
        targetMethod: "EMAIL",
        lastModifiedDatetime: LOCK,
      }),
    );
    expect(refreshMock).toHaveBeenCalled();
  });

  it("a CONFLICT result from a method-row 'Make preferred' click shows the reload-prompt banner", async () => {
    mockSetPreferredContactMethodAction.mockResolvedValueOnce({
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

    await user.click(
      screen.getByRole("button", { name: "Make email preferred" }),
    );

    expect(
      await screen.findByText(
        "This customer was changed by someone else. Reload to see the latest version.",
      ),
    ).toBeInTheDocument();
  });
});
