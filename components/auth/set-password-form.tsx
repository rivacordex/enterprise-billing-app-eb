"use client";

import { useState } from "react";
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
import {
  setPasswordSchema,
  type SetPasswordInput,
} from "@/validation/set-password.schema";

export function SetPasswordForm(): React.JSX.Element {
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<SetPasswordInput>({
    resolver: zodResolver(setPasswordSchema),
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
          const message = messages[0];
          if (message) {
            form.setError(field as keyof SetPasswordInput, { message });
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
          <p className="text-body-sm text-muted-foreground">
            At least 12 characters.
          </p>
          <FieldError errors={[errors.newPassword]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="confirmPassword">Confirm Password</FieldLabel>
          <div className="relative">
            <Input
              id="confirmPassword"
              type={showConfirm ? "text" : "password"}
              autoComplete="new-password"
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
          <FieldError errors={[errors.confirmPassword]} />
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
