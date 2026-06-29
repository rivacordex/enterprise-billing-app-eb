import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandLogo } from "@/components/brand-logo";
import type { BrandingLogo } from "@/types/system-config";

const LOGO: BrandingLogo = { src: "/brand/logo.svg", alt: "Acme Telco" };

describe("BrandLogo — wordmark/monogram fallback (logo null)", () => {
  it("renders the text wordmark for the login variant", () => {
    render(<BrandLogo variant="login" logo={null} />);
    expect(screen.getByText("Enterprise Billing")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the text wordmark for the nav variant", () => {
    render(<BrandLogo variant="nav" logo={null} />);
    expect(screen.getByText("Enterprise Billing")).toBeInTheDocument();
  });

  it("renders the monogram for the collapsed nav variant", () => {
    render(<BrandLogo variant="nav-collapsed" logo={null} />);
    expect(screen.getByText("EB")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("BrandLogo — image (logo present)", () => {
  it("renders an <img> with the src and app_name alt for the login variant", () => {
    render(<BrandLogo variant="login" logo={LOGO} />);
    const img = screen.getByRole("img", { name: "Acme Telco" });
    expect(img).toHaveAttribute("src", "/brand/logo.svg");
  });

  it("renders the nav image", () => {
    render(<BrandLogo variant="nav" logo={LOGO} />);
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
      />,
    );
    expect(screen.getByRole("img", { name: "Acme Telco" })).toHaveAttribute(
      "src",
      "/brand/mark.svg",
    );
  });

  it("falls back to the monogram for the collapsed rail when no mark is set", () => {
    render(<BrandLogo variant="nav-collapsed" logo={LOGO} />);
    expect(screen.getByText("EB")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
