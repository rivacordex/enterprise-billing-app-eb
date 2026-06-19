"use client";

import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { AuthMethodBadge } from "@/components/auth-method-badge";
import { RoleBadge } from "@/components/role-badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createUserSchema,
  type CreateUserInput,
} from "@/validation/create-user.schema";
import {
  editUserDetailsFieldsSchema,
  type EditUserDetailsFields,
} from "@/validation/update-user-details.schema";

type RoleOption = {
  roleId: string;
  roleName: string;
  roleDescr: string | null;
};

// `createUserSchema`'s `userPhonenum`/`roleIds` fields use `.nullish()`/
// `.default()`, so the schema's *input* shape (what RHF's fields actually
// hold while typing) differs from `CreateUserInput` (the parsed *output*
// shape `onSubmit` receives) — RHF's third `useForm` generic carries that
// transformation through `handleSubmit` (um08-spec §8.8).
type CreateUserFormValues = z.input<typeof createUserSchema>;

type UserFormCreateProps = {
  mode: "create";
  roles: RoleOption[];
  onSubmit: (values: CreateUserInput) => Promise<void>;
  isSubmitting: boolean;
  // Set when the action returns `EMAIL_CONFLICT` (um08-spec §"Email
  // uniqueness conflict") — not a Zod-catchable error, so it's applied to
  // the email field imperatively rather than via the resolver.
  emailConflict?: boolean;
};

type UserFormEditProps = {
  mode: "edit";
  defaultValues: { userName: string; userPhonenum: string | null };
  onSubmit: (values: EditUserDetailsFields) => Promise<void>;
  isSubmitting: boolean;
};

export type UserFormProps = UserFormCreateProps | UserFormEditProps;

const AUTH_METHOD_DESCRIPTIONS = {
  LOCAL: "Email and password. Temp password",
  SSO: "No password - via Entra ID",
} as const;

export function UserForm(props: UserFormProps): React.JSX.Element {
  if (props.mode === "edit") {
    return <EditUserForm {...props} />;
  }
  return <CreateUserForm {...props} />;
}

// `editUserDetailsFieldsSchema`'s `userPhonenum` field uses the same
// `.nullish().transform(...)` shape as the create form's, so the same
// input-vs-output generic split applies here too.
type EditUserFormValues = z.input<typeof editUserDetailsFieldsSchema>;

function EditUserForm({
  defaultValues,
  onSubmit,
  isSubmitting,
}: UserFormEditProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EditUserFormValues, unknown, EditUserDetailsFields>({
    resolver: zodResolver(editUserDetailsFieldsSchema),
    defaultValues,
  });

  // Keeps the form in sync if the selected user's underlying data changes
  // while the panel is in edit mode (um11-spec §11.5).
  useEffect(() => {
    reset(defaultValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues.userName, defaultValues.userPhonenum]);

  return (
    <form
      id="edit-user-form"
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="edit-userName">Full Name</FieldLabel>
          <Input
            id="edit-userName"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.userName}
            disabled={isSubmitting}
            {...register("userName")}
          />
          <FieldError errors={[errors.userName]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="edit-userPhonenum">Phone</FieldLabel>
          <Input
            id="edit-userPhonenum"
            type="tel"
            autoComplete="off"
            aria-invalid={!!errors.userPhonenum}
            disabled={isSubmitting}
            {...register("userPhonenum")}
          />
          <FieldError errors={[errors.userPhonenum]} />
        </Field>
      </FieldGroup>
    </form>
  );
}

function CreateUserForm({
  roles,
  onSubmit,
  isSubmitting,
  emailConflict,
}: UserFormCreateProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors },
  } = useForm<CreateUserFormValues, unknown, CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { authMethod: "LOCAL", roleIds: [] },
  });

  useEffect(() => {
    if (emailConflict) {
      setError("userEmail", {
        message: "A user with this email already exists.",
      });
    }
  }, [emailConflict, setError]);

  return (
    <form
      id="create-user-form"
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="userEmail">Email - Username</FieldLabel>
          <Input
            id="userEmail"
            type="email"
            autoComplete="off"
            aria-invalid={!!errors.userEmail}
            disabled={isSubmitting}
            {...register("userEmail")}
          />
          <FieldError errors={[errors.userEmail]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="userName">Full Name</FieldLabel>
          <Input
            id="userName"
            type="text"
            autoComplete="off"
            aria-invalid={!!errors.userName}
            disabled={isSubmitting}
            {...register("userName")}
          />
          <FieldError errors={[errors.userName]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="userPhonenum">Phone</FieldLabel>
          <Input
            id="userPhonenum"
            type="tel"
            autoComplete="off"
            aria-invalid={!!errors.userPhonenum}
            disabled={isSubmitting}
            {...register("userPhonenum")}
          />
          {errors.userPhonenum && (
            <p className="text-body-sm text-destructive">
              Phone number is too long.
            </p>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="authMethod">Auth Method</FieldLabel>
          <Controller
            control={control}
            name="authMethod"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={isSubmitting}
              >
                <SelectTrigger id="authMethod" className="w-full">
                  <SelectValue placeholder="Select an auth method" />
                </SelectTrigger>
                <SelectContent>
                  {(["LOCAL", "SSO"] as const).map((method) => (
                    <SelectItem
                      key={method}
                      value={method}
                      // Override the vendor default's `focus:bg-accent` —
                      // this project's `--accent` token is the magenta
                      // "featured CTA" color (ui-context §1.2), not a
                      // generic hover state. Matches the ghost-button
                      // hover pattern used elsewhere (components/ui/button.tsx).
                      className="focus:bg-muted focus:text-foreground"
                    >
                      <AuthMethodBadge authMethod={method} />
                      <span className="text-body-sm text-muted-foreground">
                        {AUTH_METHOD_DESCRIPTIONS[method]}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-body-sm font-medium text-foreground">
            Initial Roles (optional)
          </legend>
          {roles.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">
              No roles available.
            </p>
          ) : (
            <Controller
              control={control}
              name="roleIds"
              render={({ field }) => {
                const value = field.value ?? [];
                return (
                  <div className="flex flex-col gap-2">
                    {roles.map((role) => {
                      const checked = value.includes(role.roleId);
                      return (
                        <label
                          key={role.roleId}
                          className="flex items-start gap-2"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={isSubmitting}
                            onCheckedChange={(checkedValue) =>
                              field.onChange(
                                checkedValue
                                  ? [...value, role.roleId]
                                  : value.filter((id) => id !== role.roleId),
                              )
                            }
                          />
                          <span className="flex flex-col">
                            <RoleBadge roleName={role.roleName} />
                            {role.roleDescr && (
                              <span className="text-body-sm text-muted-foreground">
                                {role.roleDescr}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                );
              }}
            />
          )}
        </fieldset>
      </FieldGroup>
    </form>
  );
}
