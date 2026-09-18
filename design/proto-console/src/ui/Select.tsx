import clsx from "clsx";
import { useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Menu, type MenuItem } from "./Menu";

export type SelectOption<T extends string> = {
  id: T;
  label: string;
  note?: string;
  group?: string;
  icon?: ReactNode;
};

export type SelectProps<T extends string> = {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (next: T) => void;
  label: string;
  /** `field` fills its container; `chip` hugs its label. */
  shape?: "field" | "chip";
  lead?: ReactNode;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
};

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  shape = "field",
  lead,
  className,
  placeholder = "Select…",
  disabled,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = options.find((option) => option.id === value);

  const items: MenuItem[] = [];
  let group: string | undefined;
  for (const option of options) {
    if (option.group && option.group !== group) {
      group = option.group;
      items.push({ kind: "label", id: `group-${group}`, label: group });
    }
    items.push({
      id: option.id,
      label: option.label,
      checked: option.id === value,
      ...(option.note ? { detail: option.note } : {}),
      onSelect: () => onChange(option.id),
    });
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((held) => !held)}
        className={clsx(
          "inline-flex h-[var(--control-h)] items-center gap-1.5 rounded-[var(--r)] border px-2",
          "text-md transition-colors duration-[var(--fast)] disabled:opacity-40",
          shape === "field"
            ? "w-full justify-between border-rule bg-sunken"
            : "border-rule bg-raised hover:border-rule-strong",
          open && "border-accent",
          className,
        )}
      >
        {lead ? <span className="shrink-0">{lead}</span> : null}
        <span className={clsx("truncate", !current && "text-ink-4")}>
          {current?.label ?? placeholder}
        </span>
        {current?.note && shape === "field" ? (
          <span className="ml-auto shrink-0 font-mono text-xs text-ink-4">{current.note}</span>
        ) : null}
        <ChevronDown size={13} strokeWidth={1.25} className="shrink-0 text-ink-4" />
      </button>
      <Menu
        open={open}
        anchor={ref.current}
        onClose={() => setOpen(false)}
        items={items}
        label={label}
        align={shape === "field" ? "start" : "end"}
        matchWidth={shape === "field"}
      />
    </>
  );
}
