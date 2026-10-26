"use client";

// cm23 (custmgmt-ui-context §10.2, code-standards §10 Styling rule 1) — the
// per-BAN invoice template type select. Options come from
// listBindableTemplateTypes(): Standard (null) first, then usable types by
// name. A current value not among the options (a NOT_USABLE type) shows the
// placeholder; no option is added for it.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TEMPLATE_TYPE_FIELD_LABEL } from "@/components/customers/billing-account-messages";
import type { BindableTemplateType } from "@/types/accounts";

// The Select needs string item values; Standard's null maps to this sentinel
// inside this component only.
const STANDARD_ITEM = "__standard__";

function toItem(typeId: string | null): string {
  return typeId ?? STANDARD_ITEM;
}

function fromItem(item: string): string | null {
  return item === STANDARD_ITEM ? null : item;
}

export interface TemplateTypeSelectProps {
  id: string;
  options: BindableTemplateType[];
  value: string | null;
  onChange: (typeId: string | null) => void;
  disabled: boolean;
  title?: string | undefined;
}

export function TemplateTypeSelect({
  id,
  options,
  value,
  onChange,
  disabled,
  title,
}: TemplateTypeSelectProps): React.JSX.Element {
  const known = options.some((o) => o.typeId === value);
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="text-caption text-[color:var(--text-muted)]"
      >
        {TEMPLATE_TYPE_FIELD_LABEL}
      </label>
      <Select
        value={known ? toItem(value) : ""}
        onValueChange={(item) => onChange(fromItem(item))}
        disabled={disabled}
      >
        <SelectTrigger id={id} title={title} className="w-56">
          <SelectValue placeholder="Choose a type" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={toItem(o.typeId)} value={toItem(o.typeId)}>
              {o.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
