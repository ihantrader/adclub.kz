import { Chip, ChipRow, SearchField, Select } from "@adclub/ui";

/**
 * The filters of a list (TASK-080, X3–X5): one row of compact 40 fields
 * aligned by their bottom edge — the search with its placeholder, the
 * selects with their labels — and, under it, one row of chips: the status
 * (DESIGN 7.7: 36, `radiusS`, the chosen one `accentTint` with a check, its
 * count inside) or the flags of the list.
 */

/** A select of a filter: the first entry («Все») is `""` — no filter. */
export function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  allLabel = "Все",
  disabled,
}: {
  label: string;
  value: T | "" | undefined | null;
  options: readonly { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
  allLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Select<T | "all">
      compact
      label={label}
      value={value ? value : "all"}
      options={[{ value: "all", label: allLabel }, ...options]}
      disabled={disabled}
      onChange={(next) => onChange(next === "all" ? undefined : (next as T))}
      className="filters__select"
    />
  );
}

/** The search of a list: compact, its meaning in the placeholder («Название или БИН»). */
export function FilterSearch({
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** Enter: search now (a BIN, a number) instead of after the pause. */
  onSubmit?: () => void;
}) {
  return (
    <SearchField
      className="ac-search--compact filters__search"
      label={label}
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      clearLabel="Очистить поиск"
      onKeyDown={(event) => {
        if (event.key === "Enter" && onSubmit) {
          event.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

export interface StatusChip<T extends string> {
  value: T;
  label: string;
  /** The count of the server, inside the chip; `null`/`undefined` — none. */
  count?: number | null;
}

/**
 * The status filter (X5): always chips — «Все» first; a count inside the
 * chip, a zero shown muted rather than hidden only where the list is a
 * funnel (`showZero`).
 */
export function StatusChips<T extends string>({
  label,
  value,
  chips,
  onChange,
  allLabel = "Все",
  allCount,
}: {
  label: string;
  value: T | undefined;
  chips: readonly StatusChip<T>[];
  onChange: (value: T | undefined) => void;
  allLabel?: string | null;
  allCount?: number | null;
}) {
  return (
    <ChipRow label={label}>
      {allLabel !== null && (
        <Chip selected={value === undefined} onClick={() => onChange(undefined)}>
          {allLabel}
          {allCount !== undefined && allCount !== null && <ChipCount value={allCount} />}
        </Chip>
      )}
      {chips.map((chip) => (
        <Chip
          key={chip.value}
          selected={value === chip.value}
          onClick={() =>
            onChange(value === chip.value && allLabel !== null ? undefined : chip.value)
          }
        >
          {chip.label}
          {chip.count !== undefined && chip.count !== null && <ChipCount value={chip.count} />}
        </Chip>
      ))}
    </ChipRow>
  );
}

function ChipCount({ value }: { value: number }) {
  return <span className="chip-count">{value.toLocaleString("ru-RU")}</span>;
}

/** The flags of a list as chips in one row: «Без фото», «Есть неявки» (X5). */
export function FlagChips<K extends string>({
  label,
  flags,
  isOn,
  onToggle,
}: {
  label: string;
  flags: readonly { key: K; label: string }[];
  isOn: (key: K) => boolean;
  onToggle: (key: K, on: boolean) => void;
}) {
  return (
    <ChipRow label={label}>
      {flags.map((flag) => (
        <Chip
          key={flag.key}
          selected={isOn(flag.key)}
          onClick={() => onToggle(flag.key, !isOn(flag.key))}
        >
          {flag.label}
        </Chip>
      ))}
    </ChipRow>
  );
}
