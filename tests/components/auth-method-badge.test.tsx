import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AuthMethodBadge } from "@/components/auth-method-badge";

describe("AuthMethodBadge", () => {
  it("renders the SSO label", () => {
    render(<AuthMethodBadge authMethod="SSO" />);
    expect(screen.getByText("SSO")).toBeInTheDocument();
  });

  it("renders the Local label", () => {
    render(<AuthMethodBadge authMethod="LOCAL" />);
    expect(screen.getByText("Local")).toBeInTheDocument();
  });
});
