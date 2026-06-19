import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UserForm } from "@/components/users/user-form";

describe("UserForm create mode", () => {
  it("renders Email, Full Name, Phone, Auth Method, and Initial Roles fields", () => {
    render(
      <UserForm
        mode="create"
        roles={[]}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    expect(screen.getByLabelText("Email - Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Full Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone")).toBeInTheDocument();
    expect(screen.getByLabelText("Auth Method")).toBeInTheDocument();
    expect(screen.getByText("Initial Roles (optional)")).toBeInTheDocument();
  });
});

describe("UserForm edit mode", () => {
  const defaultValues = {
    userName: "Ada Lovelace",
    userPhonenum: "+1 555 0100",
  };

  it("renders only Full Name and Phone fields", () => {
    render(
      <UserForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    expect(screen.getByLabelText("Full Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email - Username")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Auth Method")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Initial Roles (optional)"),
    ).not.toBeInTheDocument();
  });

  it("pre-populates the Name and Phone inputs from defaultValues", () => {
    render(
      <UserForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    expect(screen.getByLabelText("Full Name")).toHaveValue("Ada Lovelace");
    expect(screen.getByLabelText("Phone")).toHaveValue("+1 555 0100");
  });

  it("uses the edit-user-form id so an external Save button can submit it", () => {
    render(
      <UserForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    expect(document.getElementById("edit-user-form")).toBeInTheDocument();
  });

  it("shows a validation error for an empty name without calling onSubmit", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <UserForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    await user.clear(screen.getByLabelText("Full Name"));
    const form = document.getElementById("edit-user-form") as HTMLFormElement;
    form.requestSubmit();

    await waitFor(() => {
      expect(screen.getByText("Name is required")).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit with the edited userName and userPhonenum", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <UserForm
        mode="edit"
        defaultValues={defaultValues}
        onSubmit={onSubmit}
        isSubmitting={false}
      />,
    );

    await user.clear(screen.getByLabelText("Full Name"));
    await user.type(screen.getByLabelText("Full Name"), "Grace Hopper");
    const form = document.getElementById("edit-user-form") as HTMLFormElement;
    form.requestSubmit();

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        { userName: "Grace Hopper", userPhonenum: "+1 555 0100" },
        expect.anything(),
      );
    });
  });
});
