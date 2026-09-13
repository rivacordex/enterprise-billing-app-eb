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

// Regression: an extremely wide SVG (viewBox-only, no intrinsic size) must not
// escape its bounded parent. Both the plate (a centered flex item) and the
// <img> carry `max-w-full min-w-0` so the logo shrinks to fit rather than
// overflowing the login card / top-bar brand slot.
describe("BrandLogo — wide-logo width constraints", () => {
  const WIDE_LOGO: BrandingLogo = {
    // A 2000x40 viewBox with no width/height — the exact wide, intrinsically
    // unsized case the sizing classes guard against.
    src: "/brand/wide-banner.svg",
    alt: "Extremely Wide Banner Logo",
  };

  it.each(["login", "topbar"] as const)(
    "keeps the %s img constrained (max-w-full + min-w-0)",
    (variant) => {
      render(
        <BrandLogo variant={variant} logo={WIDE_LOGO} appName="Ignored" />,
      );
      const img = screen.getByRole("img", {
        name: "Extremely Wide Banner Logo",
      });
      expect(img).toHaveClass("max-w-full", "min-w-0", "object-contain");

      // The plate wrapper is the flex item that must not expand past its parent.
      expect(img.parentElement).toHaveClass("max-w-full", "min-w-0");
    },
  );
});
