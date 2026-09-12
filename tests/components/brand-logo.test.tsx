import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandLogo } from "@/components/brand-logo";
import type { BrandingLogo } from "@/types/system-config";

const LOGO: BrandingLogo = { src: "/brand/logo.svg", alt: "Acme Telco" };

describe("BrandLogo — wordmark/monogram fallback (logo null)", () => {
  it("renders the passed appName wordmark for the login variant (truncated)", () => {
    render(<BrandLogo variant="login" logo={null} appName="Acme Telco" />);
    // truncate guards against an over-long admin-set app_name breaking layout.
    expect(screen.getByText("Acme Telco")).toHaveClass("truncate");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the passed appName wordmark for the nav variant (truncated)", () => {
    render(<BrandLogo variant="nav" logo={null} appName="Acme Telco" />);
    expect(screen.getByText("Acme Telco")).toHaveClass("truncate");
  });

  it("derives the collapsed-nav monogram from the first two words of appName", () => {
    render(
      <BrandLogo
        variant="nav-collapsed"
        logo={null}
        appName="Enterprise Billing System"
      />,
    );
    expect(screen.getByText("EB")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("derives a single-letter monogram from a one-word appName", () => {
    render(<BrandLogo variant="nav-collapsed" logo={null} appName="Acme" />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });
});

describe("BrandLogo — image (logo present)", () => {
  it("renders an <img> with the src and logo.alt for the login variant", () => {
    render(<BrandLogo variant="login" logo={LOGO} appName="Ignored" />);
    const img = screen.getByRole("img", { name: "Acme Telco" });
    expect(img).toHaveAttribute("src", "/brand/logo.svg");
  });

  it("renders the nav image with logo.alt (not appName)", () => {
    render(<BrandLogo variant="nav" logo={LOGO} appName="Ignored" />);
    expect(screen.getByRole("img", { name: "Acme Telco" })).toHaveAttribute(
      "src",
      "/brand/logo.svg",
    );
  });

  it("uses markSrc for the collapsed rail when present", () => {
    render(
      <BrandLogo
        variant="nav-collapsed"
        logo={{ ...LOGO, markSrc: "/brand/mark.svg" }}
        appName="Ignored"
      />,
    );
    expect(screen.getByRole("img", { name: "Acme Telco" })).toHaveAttribute(
      "src",
      "/brand/mark.svg",
    );
  });

  it("falls back to the appName monogram for the collapsed rail when no mark is set", () => {
    render(<BrandLogo variant="nav-collapsed" logo={LOGO} appName="Acme" />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
