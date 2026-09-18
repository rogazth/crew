import { Select as Base } from "@base-ui/react/select";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { POPUP_SURFACE } from "./Menu";

export type SelectOption = { value: string; label: string; note?: string; group?: string };

export type SelectProps = {
  value: string;
  onValueChange: (next: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
  width?: number | string;
  renderValue?: (option: SelectOption | undefined) => ReactNode;
};

const HEIGHT = { sm: "h-6 text-micro", md: "h-7 text-body", lg: "h-9 text-body" } as const;

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  className,
  size = "md",
  width,
  renderValue,
}: SelectProps) {
  const selected = options.find((o) => o.value === value);
  const groups = new Map<string, SelectOption[]>();
  for (const option of options) {
    const key = option.group ?? "";
    const held = groups.get(key);
    if (held) held.push(option);
    else groups.set(key, [option]);
  }

  return (
    <Base.Root value={value} onValueChange={(next: unknown) => onValueChange(String(next))}>
      <Base.Trigger
        className={cx(
          "inline-flex items-center justify-between gap-2 rounded-md bg-canvas px-2",
          "e1 text-left text-primary transition-shadow duration-[var(--dur-2)]",
          "data-[popup-open]:shadow-[var(--elev-1),inset_0_0_0_1px_var(--stroke-primary)]",
          HEIGHT[size],
          className,
        )}
        style={width ? { width } : undefined}
      >
        <span className="min-w-0 flex-1 truncate">
          {renderValue ? renderValue(selected) : (selected?.label ?? <span className="text-quaternary">{placeholder}</span>)}
        </span>
        <Icon name="chevronDown" size={14} className="shrink-0 text-icon-faint" />
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner sideOffset={6} align="start" className="z-[65]">
          <Base.Popup className={cx(POPUP_SURFACE, "max-h-[min(420px,60vh)] min-w-[var(--anchor-width)] overflow-auto ink-scroll")}>
            {[...groups].map(([group, items]) => (
              <Base.Group key={group || "_"}>
                {group && (
                  <Base.GroupLabel className="px-2 pb-1 pt-1.5 text-micro uppercase tracking-[0.06em] text-quaternary">
                    {group}
                  </Base.GroupLabel>
                )}
                {items.map((option) => (
                  <Base.Item
                    key={option.value}
                    value={option.value}
                    className={cx(
                      "relative flex h-7 cursor-default select-none items-center gap-2 rounded-md pl-2 pr-2 text-body",
                      "text-secondary outline-none transition-colors duration-[var(--dur-1)]",
                      "data-[highlighted]:bg-[var(--fill-tertiary)] data-[highlighted]:text-primary",
                    )}
                  >
                    <Base.ItemText className="min-w-0 flex-1 truncate">{option.label}</Base.ItemText>
                    {option.note && (
                      <span className="shrink-0 text-micro text-quaternary">{option.note}</span>
                    )}
                    <Base.ItemIndicator className="flex shrink-0 text-[var(--accent)]">
                      <Icon name="check" size={14} />
                    </Base.ItemIndicator>
                  </Base.Item>
                ))}
              </Base.Group>
            ))}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
