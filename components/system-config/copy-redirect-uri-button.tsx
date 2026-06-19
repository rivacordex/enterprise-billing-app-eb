"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface CopyRedirectUriButtonProps {
  value: string;
}

// Same optimistic copy-to-clipboard pattern as `TempPasswordDisplay`
// (um08) — admins paste this into the Entra app registration's redirect
// URI field.
export function CopyRedirectUriButton({
  value,
}: CopyRedirectUriButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  function handleCopy(): void {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={copied ? "Copied" : "Copy redirect URI"}
      onClick={handleCopy}
    >
      {copied ? (
        <Check className="text-[color:var(--color-success-700)]" />
      ) : (
        <Copy />
      )}
    </Button>
  );
}
