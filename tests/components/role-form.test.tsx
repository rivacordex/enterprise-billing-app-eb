import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RoleForm } from "@/components/roles/role-form";

describe("RoleForm create mode", () => {
  it("renders Role Name and Description fields", () => {
    render(<RoleForm mode="create" onSubmit={vi.fn()} isSubmitting={false} />);

    expect(screen.getByLabelText("Role Name")).toBeInTheDocument();
    expect(screen.getByLabelText(/Description/)).toBeInTheDocument();
  });

  it("autofocuses the Role Name input", () => {
    render(<RoleForm mode="create" onSubmit={vi.fn()} isSubmitting={false} />);
    expect(screen.getByLabelText("Role Name")).toHaveFocus();
  });

  it("shows a validation error for an empty name without calling onSubmit", async () => {
    const onSubmit = vi.fn();
    render(<RoleForm mode="create" onSubmit={onSubmit} isSubmitting={false} />);

    const form = document.getElementById("role-form") as HTMLFormElement;
    form.requestSubmit();

    await waitFor(() => {
      expect(screen.getByText("Role name is required")).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit with roleName and roleDescr", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RoleForm mode="create" onSubmit={onSubmit} isSubmitting={false} />);

    await user.type(screen.getByLabelText("Role Name"), "Finance");
    await user.type(screen.getByLabelText(/Description/), "Finance team");
    const form = document.getElementById("role-form") as HTMLFormElement;
    form.requestSubmit();

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        { roleName: "Finance", roleDescr: "Finance team" },
        expect.anything(),
      );
    });
  });

  it("submits an empty roleDescr as null", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RoleForm mode="create" onSubmit={onSubmit} isSubmitting={false} />);

    await user.type(screen.getByLabelText("Role Name"), "Finance");
    const form = document.getElementById("role-form") as HTMLFormElement;
    form.requestSubmit();

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        { roleName: "Finance", roleDescr: null },
        expect.anything(),
      );
    });
  });

  it("renders externalFieldErrors.roleName below the Role Name field", () => {
    render(
      <RoleForm
        mode="create"
        onSubmit={vi.fn()}
        isSubmitting={false}
        externalFieldErrors={{
          roleName: "A role with this name already exists.",
        }}
      />,
    );

    expect(
      screen.getByText("A role with this name already exists."),
    ).toBeInTheDocument();
  });

  it("disables both inputs while isSubmitting", () => {
    render(<RoleForm mode="create" onSubmit={vi.fn()} isSubmitting={true} />);

    expect(screen.getByLabelText("Role Name")).toBeDisabled();
    expect(screen.getByLabelText(/Description/)).toBeDisabled();
  });

  it("uses the role-form id so an external submit button can submit it", () => {
    render(<RoleForm mode="create" onSubmit={vi.fn()} isSubmitting={false} />);
    expect(document.getElementById("role-form")).toBeInTheDocument();
  });
});

describe("RoleForm edit mode", () => {
  const defaultValues = { roleName: "Finance", roleDescr: "Finance team" };

  it("renders Role Name and Description fields", () => {
    render(
      <RoleForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    expect(screen.getByLabelText("Role Name")).toBeInTheDocument();
    expect(screen.getByLabelText(/Description/)).toBeInTheDocument();
  });

  it("pre-populates the inputs from defaultValues", () => {
    render(
      <RoleForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    expect(screen.getByLabelText("Role Name")).toHaveValue("Finance");
    expect(screen.getByLabelText(/Description/)).toHaveValue("Finance team");
  });

  it("calls onSubmit with the updated RoleFormValues shape", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <RoleForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    await user.clear(screen.getByLabelText("Role Name"));
    await user.type(screen.getByLabelText("Role Name"), "Finance Renamed");
    const form = document.getElementById("role-form") as HTMLFormElement;
    form.requestSubmit();

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        { roleName: "Finance Renamed", roleDescr: "Finance team" },
        expect.anything(),
      );
    });
  });

  it("renders externalFieldErrors.roleName below the Role Name field", () => {
    render(
      <RoleForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={vi.fn()}
        isSubmitting={false}
        externalFieldErrors={{
          roleName: "A role with this name already exists.",
        }}
      />,
    );

    expect(
      screen.getByText("A role with this name already exists."),
    ).toBeInTheDocument();
  });

  it("disables both inputs while isSubmitting", () => {
    render(
      <RoleForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={vi.fn()}
        isSubmitting={true}
      />,
    );

    expect(screen.getByLabelText("Role Name")).toBeDisabled();
    expect(screen.getByLabelText(/Description/)).toBeDisabled();
  });

  it("uses the role-form id so an external submit button can submit it", () => {
    render(
      <RoleForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );
    expect(document.getElementById("role-form")).toBeInTheDocument();
  });
});
