"use client";

import { useMemo, useState } from "react";
import type { FieldError as RhfFieldError } from "react-hook-form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { setPasswordAction } from "@/actions/auth/set-password.action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { PasswordPolicy } from "@/types/password";
import { DEFAULT_PASSWORD_POLICY } from "@/validation/password";
import {
  buildSetPasswordSchema,
  type SetPasswordInput,
} from "@/validation/set-password.schema";

// um25-spec §"Error messages". `criteriaMode: "all"` makes the zod resolver
// collect every failing `.superRefine()` rule into `error.types` instead of
// just the first; this flattens that (or a single `setError({ types })` call
// from the server VALIDATION_ERROR path below) into a flat message list so
// every violated rule renders simultaneously.
function fieldErrorMessages(error: RhfFieldError | undefined): string[] {
  if (!error) return [];
  if (error.types) {
    return Object.values(error.types).flatMap((value) =>
      Array.isArray(value) ? value : [value],
    ) as string[];
  }
  return error.message ? [error.message] : [];
}

export interface SetPasswordFormProps {
  // Optional with a default so the contract stays ergonomic; the page always
  // passes the real env-derived policy. DEFAULT_PASSWORD_POLICY is client-safe
  // (no lib/config import) and matches the server's schema defaults.
  policy?: PasswordPolicy;
  passwordPolicyHints?: string[];
}

export function SetPasswordForm({
  policy = DEFAULT_PASSWORD_POLICY,
  passwordPolicyHints,
}: SetPasswordFormProps): React.JSX.Element {
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Built from the server-provided policy (passed as a prop) so this client
  // component never imports lib/config (server-only) transitively.
  const schema = useMemo(() => buildSetPasswordSchema(policy), [policy]);

  const form = useForm<SetPasswordInput>({
    resolver: zodResolver(schema),
    criteriaMode: "all",
    defaultValues: { newPassword: "", confirmPassword: "" },
  });
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;

  // When `setPasswordAction` calls `redirect('/')` server-side, this
  // component unmounts before the promise resolves on the client — `result`
  // is only ever observed for the error-return paths.
  async function onSubmit(values: SetPasswordInput): Promise<void> {
    setServerError(null);
    const result = await setPasswordAction(values);

    if (!result?.ok) {
      if (result?.code === "VALIDATION_ERROR") {
        Object.entries(result.fieldErrors).forEach(([field, messages]) => {
          if (messages.length > 0) {
            form.setError(field as keyof SetPasswordInput, {
              type: "server",
              types: { server: messages },
            });
          }
        });
      } else {
        setServerError("Something went wrong. Please try again.");
      }
    }
  }

  return (
    <form
      noValidate
      method="post"
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="newPassword">New Password</FieldLabel>
          <div className="relative">
            <Input
              id="newPassword"
              type={showNew ? "text" : "password"}
              autoComplete="new-password"
              maxLength={128}
              aria-invalid={!!errors.newPassword}
              className="pr-9"
              {...register("newPassword")}
            />
            <button
              type="button"
              aria-label={showNew ? "Hide password" : "Show password"}
              aria-pressed={showNew}
              onClick={() => setShowNew((value) => !value)}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              {showNew ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
          {passwordPolicyHints && passwordPolicyHints.length > 0 && (
            <ul className="ml-4 list-disc text-body-sm text-muted-foreground">
              {passwordPolicyHints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          )}
          <FieldError
            errors={fieldErrorMessages(errors.newPassword).map((message) => ({
              message,
            }))}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="confirmPassword">Confirm Password</FieldLabel>
          <div className="relative">
            <Input
              id="confirmPassword"
              type={showConfirm ? "text" : "password"}
              autoComplete="new-password"
              maxLength={128}
              aria-invalid={!!errors.confirmPassword}
              className="pr-9"
              {...register("confirmPassword")}
            />
            <button
              type="button"
              aria-label={showConfirm ? "Hide password" : "Show password"}
              aria-pressed={showConfirm}
              onClick={() => setShowConfirm((value) => !value)}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              {showConfirm ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
          <FieldError
            errors={fieldErrorMessages(errors.confirmPassword).map(
              (message) => ({ message }),
            )}
          />
        </Field>

        {serverError && (
          <Alert variant="destructive">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          Set Password
        </Button>
      </FieldGroup>
    </form>
  );
}
