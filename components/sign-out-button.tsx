"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button, type buttonVariants } from "@/components/ui/button";
import { authClient } from "@/auth/client";
import type { VariantProps } from "class-variance-authority";

export interface SignOutButtonProps extends Pick<
  VariantProps<typeof buttonVariants>,
  "variant"
> {
  className?: string;
}

export function SignOutButton({
  variant,
  className,
}: SignOutButtonProps = {}): React.JSX.Element {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);

  async function handleSignOut(): Promise<void> {
    setIsPending(true);
    await authClient.signOut();
    router.push("/login");
  }

  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      onClick={() => void handleSignOut()}
      disabled={isPending}
    >
      {isPending && <Loader2 className="animate-spin" />}
      Sign out
    </Button>
  );
}
