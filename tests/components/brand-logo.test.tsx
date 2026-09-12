import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandLogo } from "@/components/brand-logo";
import type { BrandingLogo } from "@/types/system-config";

const LOGO: BrandingLogo = { src: "/brand/logo.svg", alt: "Acme Telco" };

// D10: only "login" and "topbar" remain — the "nav"/"nav-collapsed" variants
// and their monogram fallback are deleted with the sidebar brand.
describe("BrandLogo — wordmark fallback (logo null)", () => {
  it("renders the passed appName wordmark for the login variant (truncated)", () => {
    render(<BrandLogo variant="login" logo={null} appName="Acme Telco" />);
    expect(screen.getByText("Acme Telco")).toHaveClass("truncate");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the passed appName wordmark for the topbar variant (truncated)", () => {
    render(<BrandLogo variant="topbar" logo={null} appName="Acme Telco" />);
    expect(screen.getByText("Acme Telco")).toHaveClass("truncate");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("BrandLogo — image (logo present)", () => {
  it("renders an <img> with the src and logo.alt for the login variant", () => {
    render(<BrandLogo variant="login" logo={LOGO} appName="Ignored" />);
    const img = screen.getByRole("img", { name: "Acme Telco" });
    expect(img).toHaveAttribute("src", "/brand/logo.svg");
  });

  it("renders the topbar image with logo.alt (not appName)", () => {
    render(<BrandLogo variant="topbar" logo={LOGO} appName="Ignored" />);
    expect(screen.getByRole("img", { name: "Acme Telco" })).toHaveAttribute(
      "src",
      "/brand/logo.svg",
    );
  });
});
