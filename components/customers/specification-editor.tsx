"use client";

import { cn } from "@/lib/utils";

export interface SpecificationEditorProps {
  value: string;
  onChange: (next: string) => void;
}

function validate(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? null
      : "Must be a JSON object.";
  } catch {
    return "Invalid JSON.";
  }
}

// The one component for editing `party_role_specification` (code-standards
// §4.4) — a raw JSON textarea with client-side JSON.parse feedback mirroring
// `parseSpecificationInput`'s well-formedness-only check (cm07-spec §2.3.4,
// §3.8). This is UX only — the server call is still the actual gate.
export function SpecificationEditor({
  value,
  onChange,
}: SpecificationEditorProps): React.JSX.Element {
  const error = validate(value);

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        className={cn(
          "w-full rounded-md border bg-[color:var(--surface-sunken)] p-2 font-mono text-body-sm",
          error
            ? "border-[color:var(--color-danger-500)]"
            : "border-[color:var(--border-default)]",
        )}
        aria-label="Party role specification (JSON)"
        aria-invalid={error !== null}
      />
      {error && (
        <p className="mt-1 text-caption text-[color:var(--color-danger-700)]">
          {error}
        </p>
      )}
    </div>
  );
}
