type CharacteristicChipProps = {
  chKey: string;
  value: string;
};

export function CharacteristicChip({
  chKey,
  value,
}: CharacteristicChipProps): React.JSX.Element {
  return (
    <span className="inline-flex flex-col rounded-[var(--radius-xs)] bg-[color:var(--surface-sunken)] px-2 py-1">
      <span className="text-overline font-semibold tracking-wider text-[color:var(--color-neutral-500)] uppercase">
        {chKey}
      </span>
      <span className="font-mono text-[color:var(--color-neutral-800)] tabular-nums">
        {value}
      </span>
    </span>
  );
}
