import { Star } from "lucide-react";

export interface PreferredIndicatorProps {
  // Optional so the two cm05 call sites can rely on the generic default —
  // the surrounding row context (name, or a phone/email/address icon next
  // to it) already disambiguates visually. A future unit can pass a more
  // specific announcement string ("Preferred phone") if needed.
  label?: string;
}

export function PreferredIndicator({
  label,
}: PreferredIndicatorProps): React.JSX.Element {
  return (
    <Star
      size={14}
      className="fill-current text-[color:var(--preferred-fg)]"
      aria-label={label ?? "Preferred"}
    />
  );
}
