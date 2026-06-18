import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Home from "@/app/page";

describe("Home placeholder page", () => {
  it("renders the product wordmark", () => {
    render(<Home />);
    expect(screen.getByText("Enterprise Billing")).toBeInTheDocument();
  });

  it("renders the module title", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { name: "User Management" }),
    ).toBeInTheDocument();
  });
});
