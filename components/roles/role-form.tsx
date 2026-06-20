"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createRoleSchema,
  type CreateRoleInput,
} from "@/validation/create-role.schema";
import {
  editRoleFieldsSchema,
  type EditRoleFields,
} from "@/validation/update-role.schema";

type RoleFormCreateProps = {
  mode: "create";
  onSubmit: (values: CreateRoleInput) => Promise<void>;
  isSubmitting: boolean;
  // Set when the action returns `NAME_CONFLICT` (um19-spec §19.5) — not a
  // Zod-catchable error, so it's surfaced imperatively rather than via the
  // resolver, mirroring `UserForm`'s `emailConflict` prop. Typed `| undefined`
  // (not just `?:`) so callers can pass a conditional ternary directly under
  // `exactOptionalPropertyTypes`.
  externalFieldErrors?: { roleName?: string } | undefined;
};

type RoleFormEditProps = {
  mode: "edit";
  defaultValues: { roleName: string; roleDescr: string | null };
  onSubmit: (values: EditRoleFields) => Promise<void>;
  isSubmitting: boolean;
  externalFieldErrors?: { roleName?: string } | undefined;
};

export type RoleFormProps = RoleFormCreateProps | RoleFormEditProps;

export function RoleForm(props: RoleFormProps): React.JSX.Element {
  if (props.mode === "edit") {
    return <EditRoleForm {...props} />;
  }
  return <CreateRoleForm {...props} />;
}

// `editRoleFieldsSchema`'s `roleDescr` field uses the same
// `.nullish().transform(...)` shape as the create schema's, so the same
// input-vs-output generic split applies here too (mirrors `UserForm`).
type EditRoleFormValues = z.input<typeof editRoleFieldsSchema>;

function EditRoleForm({
  defaultValues,
  onSubmit,
  isSubmitting,
  externalFieldErrors,
}: RoleFormEditProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<EditRoleFormValues, unknown, EditRoleFields>({
    resolver: zodResolver(editRoleFieldsSchema),
    defaultValues: {
      roleName: defaultValues.roleName,
      roleDescr: defaultValues.roleDescr ?? "",
    },
  });

  // Keeps the form in sync if the selected role changes while the panel is
  // in edit mode (um19-spec §19.5), mirroring `UserForm`'s edit-mode effect.
  useEffect(() => {
    reset({
      roleName: defaultValues.roleName,
      roleDescr: defaultValues.roleDescr ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues.roleName, defaultValues.roleDescr]);

  return (
    <form
      id="role-form"
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="edit-roleName">Role Name</FieldLabel>
          <Input
            id="edit-roleName"
            type="text"
            autoComplete="off"
            autoFocus
            aria-invalid={!!errors.roleName}
            disabled={isSubmitting}
            {...register("roleName")}
          />
          <FieldError errors={[errors.roleName]} />
          {externalFieldErrors?.roleName && !errors.roleName && (
            <p className="text-sm font-normal text-destructive">
              {externalFieldErrors.roleName}
            </p>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="edit-roleDescr">
            Description{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </FieldLabel>
          <Textarea
            id="edit-roleDescr"
            rows={3}
            aria-invalid={!!errors.roleDescr}
            disabled={isSubmitting}
            {...register("roleDescr")}
          />
          <FieldError errors={[errors.roleDescr]} />
        </Field>
      </FieldGroup>
    </form>
  );
}

type CreateRoleFormValues = z.input<typeof createRoleSchema>;

function CreateRoleForm({
  onSubmit,
  isSubmitting,
  externalFieldErrors,
}: RoleFormCreateProps): React.JSX.Element {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateRoleFormValues, unknown, CreateRoleInput>({
    resolver: zodResolver(createRoleSchema),
    defaultValues: { roleName: "", roleDescr: "" },
  });

  return (
    <form
      id="role-form"
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="roleName">Role Name</FieldLabel>
          <Input
            id="roleName"
            type="text"
            autoComplete="off"
            autoFocus
            aria-invalid={!!errors.roleName}
            disabled={isSubmitting}
            {...register("roleName")}
          />
          <FieldError errors={[errors.roleName]} />
          {externalFieldErrors?.roleName && !errors.roleName && (
            <p className="text-sm font-normal text-destructive">
              {externalFieldErrors.roleName}
            </p>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="roleDescr">
            Description{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </FieldLabel>
          <Textarea
            id="roleDescr"
            rows={3}
            aria-invalid={!!errors.roleDescr}
            disabled={isSubmitting}
            {...register("roleDescr")}
          />
          <FieldError errors={[errors.roleDescr]} />
        </Field>
      </FieldGroup>
    </form>
  );
}
