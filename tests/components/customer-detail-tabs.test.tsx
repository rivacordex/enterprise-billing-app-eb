import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustomerDetailTabs } from "@/components/customers/customer-detail-tabs";
import { CUSTOMER_DETAIL_TABS } from "@/validation/customer/search-params.schema";

// cm19-spec §3.4.
describe("CustomerDetailTabs", () => {
  it("renders the three tab links with ?tab= hrefs and labels", () => {
    render(<CustomerDetailTabs activeTab="profile" />);

    expect(
      screen.getByRole("navigation", { name: "Customer detail tabs" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "href",
      "?tab=profile",
    );
    expect(screen.getByRole("link", { name: "Contacts" })).toHaveAttribute(
      "href",
      "?tab=contacts",
    );
    expect(screen.getByRole("link", { name: "Accounts" })).toHaveAttribute(
      "href",
      "?tab=accounts",
    );
  });

  it.each(CUSTOMER_DETAIL_TABS)(
    "marks exactly one link aria-current=page (active: %s)",
    (activeTab) => {
      render(<CustomerDetailTabs activeTab={activeTab} />);

      const current = screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page");
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveAttribute("href", `?tab=${activeTab}`);
    },
  );
});
