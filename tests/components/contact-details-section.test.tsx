import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ContactDetailsSection } from "@/components/customers/contact-details-section";
import type { ContactRow } from "@/types/customer";

const BASE_CONTACT: ContactRow = {
  contactMediumId: "CTMD00000001",
  contactName: "Taylor Chen",
  contactRole: "Billing Contact",
  phoneNumber: "555-0100",
  emailAddress: "taylor@example.com",
  address: {
    line1: "1 Main St",
    line2: null,
    city: "Springfield",
    stateProvince: "IL",
    postalCode: "62701",
    country: "USA",
  },
  preferredMethod: "EMAIL",
  isPreferredContact: true,
};

describe("ContactDetailsSection", () => {
  it("renders the empty state when there are zero contacts", () => {
    render(<ContactDetailsSection contacts={[]} />);

    expect(screen.getByText("No contacts on file")).toBeInTheDocument();
  });

  it("a contact with all three methods populated shows exactly one PreferredIndicator on the preferred method plus one next to the name (isPreferredContact)", () => {
    render(<ContactDetailsSection contacts={[BASE_CONTACT]} />);

    const indicators = screen.getAllByLabelText("Preferred");
    expect(indicators).toHaveLength(2);
    expect(screen.getByText("555-0100")).toBeInTheDocument();
    expect(screen.getByText("taylor@example.com")).toBeInTheDocument();
    expect(screen.getByText("1 Main St")).toBeInTheDocument();
  });

  it("a contact with address: null renders no address row and no crash", () => {
    render(
      <ContactDetailsSection
        contacts={[
          { ...BASE_CONTACT, address: null, preferredMethod: "EMAIL" },
        ]}
      />,
    );

    expect(screen.queryByText("1 Main St")).not.toBeInTheDocument();
    expect(screen.getByText("555-0100")).toBeInTheDocument();
  });

  it("a contact with no populated method at all renders the no-method state and no PreferredIndicator anywhere on the row", () => {
    render(
      <ContactDetailsSection
        contacts={[
          {
            ...BASE_CONTACT,
            phoneNumber: null,
            emailAddress: null,
            address: null,
            preferredMethod: null,
          },
        ]}
      />,
    );

    expect(screen.getByText("No contact method on file")).toBeInTheDocument();
    expect(screen.queryByLabelText("Preferred")).not.toBeInTheDocument();
  });
});
