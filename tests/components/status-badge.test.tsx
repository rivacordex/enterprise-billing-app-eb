import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "@/components/status-badge";

describe("StatusBadge", () => {
  it.each([
    ["ACTIVE", "Active"],
    ["PENDING", "Pending"],
    ["DISABLED", "Disabled"],
    ["DELETED", "Deleted"],
  ] as const)("renders the %s label", (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("renders a Locked chip alongside the status when isLocked is true", () => {
    render(<StatusBadge status="ACTIVE" isLocked />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Locked")).toBeInTheDocument();
  });

  it("does not render a Locked chip when isLocked is false", () => {
    render(<StatusBadge status="ACTIVE" isLocked={false} />);
    expect(screen.queryByText("Locked")).not.toBeInTheDocument();
  });

  it("renders DELETED with line-through styling", () => {
    render(<StatusBadge status="DELETED" />);
    expect(screen.getByText("Deleted")).toHaveClass("line-through");
  });
});
