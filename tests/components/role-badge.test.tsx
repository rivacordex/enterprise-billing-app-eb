import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RoleBadge } from "@/components/role-badge";

describe("RoleBadge", () => {
  it.each(["ADMIN", "MANAGER", "USER"])(
    "renders the %s label as-is",
    (roleName) => {
      render(<RoleBadge roleName={roleName} />);
      expect(screen.getByText(roleName)).toBeInTheDocument();
    },
  );

  it("does not crash on an unrecognised role name and renders it as-is", () => {
    render(<RoleBadge roleName="SUPER_ADMIN" />);
    expect(screen.getByText("SUPER_ADMIN")).toBeInTheDocument();
  });
});
