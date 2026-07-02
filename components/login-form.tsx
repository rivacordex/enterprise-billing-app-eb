"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { authClient } from "@/auth/client";
import { CSRF_HEADER_NAME } from "@/lib/csrf-shared";
import { AUTH_ERROR_CODES } from "@/types/auth";
import { loginSchema, type LoginInput } from "@/validation/login.schema";

const ERROR_MESSAGES = {
  invalid: "Invalid email or address.",
  notActive:
    "Your account is not currently active. Contact your administrator.",
  locked:
    "Your account has been temporarily locked. Contact your administrator.",
  sessionExpired: "Your session has expired. Please refresh and try again.",
  unexpected: "Something went wrong. Please try again.",
} as const;

export function LoginForm({
  csrfToken,
}: {
  csrfToken: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  async function onSubmit(values: LoginInput): Promise<void> {
    setFormError(null);

    const { error } = await authClient.signIn.email(
      {
        email: values.email,
        password: values.password,
      },
      { headers: { [CSRF_HEADER_NAME]: csrfToken ?? "" } },
    );

    if (!error) {
      router.push("/");
      return;
    }

    if (error.code === AUTH_ERROR_CODES.USER_NOT_ACTIVE) {
      setFormError(ERROR_MESSAGES.notActive);
    } else if (error.code === AUTH_ERROR_CODES.USER_LOCKED) {
      setFormError(ERROR_MESSAGES.locked);
    } else if (error.code === AUTH_ERROR_CODES.INVALID_CSRF_TOKEN) {
      setFormError(ERROR_MESSAGES.sessionExpired);
    } else if (typeof error.status === "number" && error.status >= 500) {
      setFormError(ERROR_MESSAGES.unexpected);
    } else {
      setFormError(ERROR_MESSAGES.invalid);
    }
  }

  return (
    <form
      noValidate
      method="post"
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
    >
      {/* ZAP PR13 fix (rule 10202) — a visible token field, matched against
          the httpOnly cookie proxy.ts set alongside it. */}
      <input type="hidden" name="_csrf" value={csrfToken ?? ""} />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={!!errors.email}
            {...register("email")}
          />
          <FieldError errors={[errors.email]} />
        </Field>

        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              className="pr-9"
              {...register("password")}
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((value) => !value)}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
          <FieldError errors={[errors.password]} />
        </Field>

        {formError && (
          <p role="alert" className="text-body text-destructive">
            {formError}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          Sign in
        </Button>
      </FieldGroup>
    </form>
  );
}
