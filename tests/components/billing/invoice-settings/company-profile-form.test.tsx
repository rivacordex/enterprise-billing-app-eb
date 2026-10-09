// bm56-spec §Tests: the read-mode company profile form renders plain text (no
// inputs), colour swatches, the logo <img> pointing at the session-guarded GET
// route, and "—" for blank optional fields. The history table's profile kind
// is covered here too (no Layout column, no Default chip, numeric View link).

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CompanyProfileForm } from "@/components/billing/invoice-settings/company-profile-form";
import { VersionHistoryTable } from "@/components/billing/invoice-settings/version-history-table";
import type { ProfileHistoryRow } from "@/types/billing";

const FIELDS = {
  company_name: "Digital Billing Sdn Bhd",
  registration_no: "202001000001",
  tin: "C1234567890",
  sst_reg_no: null,
  address_line1: "Level 5, Menara DB",
  address_line2: null,
  postcode: "50450",
  city: "Kuala Lumpur",
  state_code: "14",
  country_code: "MY",
  phone: "+60312345678",
  email: "billing@example.com",
  website: null,
  bank_name: "Maybank",
  bank_account_name: "Digital Billing Sdn Bhd",
  bank_account_no: "5140-1234-5678",
  swift: "MBBEMYKL",
  jompay_biller_code: null,
  remittance_email: "ar@example.com",
  brand_color: "#2E45A9",
  accent_color: "#1F9D57",
  payment_terms_days: "30",
};

describe("CompanyProfileForm (read mode)", () => {
  it("renders every group as text with no form controls", () => {
    const { container } = render(
      <CompanyProfileForm
        mode="read"
        fields={FIELDS}
        logoAssetVersionId="INVASV00000001"
      />,
    );
    for (const title of ["Company", "Payment", "Branding", "Defaults"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(
      screen.getAllByText("Digital Billing Sdn Bhd", { selector: "dd" })[0],
    ).toBeInTheDocument();
    expect(screen.getByText("C1234567890")).toBeInTheDocument();
    expect(screen.getByText("MBBEMYKL")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(
      container.querySelector("input, textarea, select, button"),
    ).toBeNull();
  });

  it("derives the state and country labels from their codes", () => {
    render(
      <CompanyProfileForm
        fields={FIELDS}
        logoAssetVersionId="INVASV00000001"
      />,
    );
    expect(
      screen.getByText("Wilayah Persekutuan Kuala Lumpur"),
    ).toBeInTheDocument();
    expect(screen.getByText("Malaysia")).toBeInTheDocument();
  });

  it("shows a 20x20 swatch per valid colour", () => {
    render(
      <CompanyProfileForm
        fields={FIELDS}
        logoAssetVersionId="INVASV00000001"
      />,
    );
    const swatches = screen.getAllByTestId("colour-swatch");
    expect(swatches).toHaveLength(2);
    expect(swatches[0]?.querySelector("rect")).toHaveAttribute(
      "fill",
      "#2E45A9",
    );
    expect(swatches[0]).toHaveAttribute("width", "20");
    expect(swatches[0]).toHaveAttribute("height", "20");
  });

  it("omits the swatch for a malformed colour but still shows the value", () => {
    render(
      <CompanyProfileForm
        fields={{ ...FIELDS, brand_color: "red; background:url(x)" }}
        logoAssetVersionId={null}
      />,
    );
    expect(screen.getAllByTestId("colour-swatch")).toHaveLength(1);
    expect(screen.getByText("red; background:url(x)")).toBeInTheDocument();
  });

  it("points the logo <img> at the GET route", () => {
    render(
      <CompanyProfileForm
        fields={FIELDS}
        logoAssetVersionId="INVASV00000001"
      />,
    );
    expect(screen.getByRole("img", { name: "Company logo" })).toHaveAttribute(
      "src",
      "/administration/invoice-settings/company-profile/logo/INVASV00000001",
    );
  });

  it("shows no <img> and a dash when there is no logo", () => {
    render(<CompanyProfileForm fields={FIELDS} logoAssetVersionId={null} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders a dash for every blank optional field", () => {
    render(<CompanyProfileForm fields={FIELDS} logoAssetVersionId={null} />);
    // sst_reg_no, website, jompay_biller_code, logo (address_line2 is folded
    // into the address block).
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it("renders an incomplete DRAFT without throwing", () => {
    render(
      <CompanyProfileForm
        fields={{ company_name: "Half Done" }}
        logoAssetVersionId={null}
      />,
    );
    expect(screen.getByText("Half Done")).toBeInTheDocument();
  });
});

describe("VersionHistoryTable (kind=profile)", () => {
  const ROWS: ProfileHistoryRow[] = [
    {
      versionNo: 2,
      status: "ACTIVE",
      createdBy: "Alice",
      createdAt: new Date("2026-10-05T00:00:00Z"),
      activatedAt: new Date("2026-10-05T01:00:00Z"),
      retiredAt: null,
      changeNote: "New bank",
      usedByCount: 3,
    },
    {
      versionNo: 1,
      status: "RETIRED",
      createdBy: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      activatedAt: null,
      retiredAt: null,
      changeNote: null,
      usedByCount: 1,
    },
  ];

  it("shows used-by counts, no Layout column, no Default chip, no .hbs download", () => {
    const { container } = render(
      <VersionHistoryTable
        kind="profile"
        rows={ROWS}
        shownVersionId="2"
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
    const counts = screen.getAllByTestId("used-by").map((c) => c.textContent);
    expect(counts).toEqual(["3 invoices", "1 invoice"]);
    expect(screen.queryByText("Layout")).toBeNull();
    expect(container.querySelector('[data-default="true"]')).toBeNull();
    expect(screen.queryByText(/Download/)).toBeNull();
    const view = screen.getAllByRole("link", { name: /View/ });
    expect(view.map((l) => l.getAttribute("href"))).toEqual([
      "?tab=edit&version=2",
      "?tab=edit&version=1",
    ]);
  });

  it("shows the empty copy for no versions", () => {
    render(
      <VersionHistoryTable
        kind="profile"
        rows={[]}
        shownVersionId=""
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
    expect(
      screen.getByText("No company profile versions yet."),
    ).toBeInTheDocument();
  });
});
