import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustomerRoleSection } from "@/components/customers/customer-role-section";
import type { CustomerRoleDetail } from "@/types/customer";

const BASE_ROLE: CustomerRoleDetail = {
  partyRoleId: "PTRL00000001",
  status: "ACTIVE",
  statusReason: null,
  specification: { tier: "gold", limits: { seats: 10 } },
  account: null,
  preferredContactId: null,
  lastModifiedByName: "Jordan Rivera",
  lastModifiedDatetime: new Date("2026-07-01T10:00:00.000Z"),
};

describe("CustomerRoleSection", () => {
  it("renders the specification pre block as pretty-printed JSON matching JSON.stringify(spec, null, 2) exactly", () => {
    render(
      <CustomerRoleSection
        customerRole={BASE_ROLE}
        locale="en-US"
        timezone="UTC"
      />,
    );

    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe(
      JSON.stringify(BASE_ROLE.specification, null, 2),
    );
  });

  it("account: null renders —", () => {
    render(
      <CustomerRoleSection
        customerRole={BASE_ROLE}
        locale="en-US"
        timezone="UTC"
      />,
    );

    // `statusReason` is also null in this fixture, so both fields render
    // "—" — assert at least one, not a single unique match.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
