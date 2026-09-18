import clsx from "clsx";
import type { ReactNode } from "react";

/** Radius is 3 everywhere, so the switch is a rectangle. That is the point. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative h-[14px] w-[26px] shrink-0 rounded-[var(--r)] border transition-colors duration-[var(--base)]",
        "disabled:opacity-40",
        checked ? "border-accent bg-accent" : "border-rule-strong bg-sunken",
      )}
    >
      <span
        className={clsx(
          "absolute top-[1px] block size-[10px] rounded-[2px] transition-all duration-[var(--base)]",
          checked ? "left-[13px] bg-accent-on" : "left-[1px] bg-ink-3",
        )}
      />
    </button>
  );
}

/**
 * `readOnly` renders a span instead of a button, for the case where a whole row
 * is already the control — a nested button there is invalid HTML.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  className,
  readOnly,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  label: string;
  className?: string;
  readOnly?: boolean;
}) {
  const box = clsx(
    "grid size-[13px] shrink-0 place-items-center rounded-[var(--r)] border transition-colors duration-[var(--fast)]",
    checked ? "border-accent bg-accent text-accent-on" : "border-rule-strong bg-sunken",
    className,
  );
  const mark = checked ? (
    <svg viewBox="0 0 10 10" className="size-[9px]" aria-hidden>
      <path d="M1.5 5.2 3.9 7.5 8.5 2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ) : null;
  if (readOnly) {
    return (
      <span aria-hidden className={box}>
        {mark}
      </span>
    );
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange?.(!checked)}
      className={box}
    >
      {mark}
    </button>
  );
}

export function Radio({
  checked,
  onChange,
  label,
  className,
  readOnly,
}: {
  checked: boolean;
  onChange?: () => void;
  label: string;
  className?: string;
  readOnly?: boolean;
}) {
  const box = clsx(
    "grid size-[13px] shrink-0 place-items-center rounded-[var(--r)] border transition-colors duration-[var(--fast)]",
    checked ? "border-accent" : "border-rule-strong bg-sunken",
    className,
  );
  const mark = checked ? <span className="block size-[7px] rounded-full bg-accent" /> : null;
  if (readOnly) {
    return (
      <span aria-hidden className={box}>
        {mark}
      </span>
    );
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={box}
    >
      {mark}
    </button>
  );
}

export type SegmentedOption<T extends string> = { id: T; label: ReactNode; title?: string };

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (next: T) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={clsx(
        "inline-flex h-[var(--control-h)] items-stretch rounded-[var(--r)] border border-rule bg-raised p-px",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title ?? undefined}
            onClick={() => onChange(option.id)}
            className={clsx(
              "flex items-center gap-1 rounded-[2px] px-2 text-md whitespace-nowrap transition-colors duration-[var(--fast)]",
              active ? "bg-ink text-on-ink" : "text-ink-2 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
