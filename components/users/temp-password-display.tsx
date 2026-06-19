"use client";

import { useState } from "react";
import { AlertTriangle, Check, CheckCircle, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface TempPasswordDisplayProps {
  tempPassword: string;
  onDone: () => void;
}

export function TempPasswordDisplay({
  tempPassword,
  onDone,
}: TempPasswordDisplayProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  function handleCopy(): void {
    // Clipboard access can be denied by browser policy (e.g. permissions,
    // insecure context) — that failure shouldn't surface as an unhandled
    // rejection or block the optimistic "Copied" feedback. The API itself
    // may also simply not exist (e.g. a non-secure context), hence the
    // presence guard.
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(tempPassword).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <CheckCircle
        size={32}
        className="text-[color:var(--color-success-700)]"
      />
      <h3 className="text-h3 font-semibold text-foreground">User created</h3>
      <p className="text-body text-muted-foreground">
        Share this temporary password with the user out of band. It will not be
        shown again.
      </p>

      <div className="flex w-full items-center gap-2">
        <code className="flex-1 rounded-md bg-[color:var(--surface-sunken)] px-3 py-2 font-mono text-sm break-all select-all">
          {tempPassword}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={copied ? "Copied" : "Copy password"}
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="text-[color:var(--color-success-700)]" />
          ) : (
            <Copy />
          )}
        </Button>
      </div>

      <p className="flex items-center gap-1 text-body-sm font-medium text-[color:var(--color-warning-700)]">
        <AlertTriangle size={14} aria-hidden="true" />
        This password will not be shown again.
      </p>

      <Button type="button" className="w-full" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
