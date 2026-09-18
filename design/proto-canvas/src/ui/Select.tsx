import type { ReactNode } from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { cx } from "@/lib/cx";
import { Icon } from "./Icon";

export type Option<T extends string> = { value: T; label: string; note?: string; icon?: ReactNode };
export type OptionGroup<T extends string> = { label: string; options: Array<Option<T>> };

export function Select<T extends string>({
  value,
  onChange,
  options,
  groups,
  placeholder = "Select…",
  className,
  size = "md",
  align = "start",
  trigger,
}: {
  value: T | null;
  onChange: (next: T) => void;
  options?: ReadonlyArray<Option<T>>;
  groups?: ReadonlyArray<OptionGroup<T>>;
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
  align?: "start" | "center" | "end";
  /** Replaces the default field shape, for the composer's compact chip. */
  trigger?: (label: string) => ReactNode;
}) {
  const all = groups ? groups.flatMap((g) => g.options) : (options ?? []);
  const current = all.find((o) => o.value === value);
  const label = current?.label ?? placeholder;

  return (
    <BaseSelect.Root value={value} onValueChange={(next) => next !== null && onChange(next as T)}>
      <BaseSelect.Trigger
        className={cx(
          trigger
            ? "outline-none"
            : cx(
                "rise flex items-center justify-between gap-2 rounded-control bg-raised el-2 text-left text-ink",
                size === "sm" ? "h-7 px-2.5 text-sm" : "h-9 px-3 text-base",
              ),
          className,
        )}
      >
        {trigger ? (
          trigger(label)
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-2 truncate">
              {current?.icon}
              <span className="truncate">{label}</span>
            </span>
            <Icon name="chevrons" size={14} className="shrink-0 text-ink-38" />
          </>
        )}
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          align={align}
          sideOffset={6}
          alignItemWithTrigger={false}
          className="z-[75]"
        >
          <BaseSelect.Popup className="enter-pop max-h-[min(420px,60vh)] min-w-[var(--anchor-width)] overflow-auto rounded-card bg-overlay p-1.5 el-3 outline-none scroller">
            <BaseSelect.List>
              {groups
                ? groups.map((group) => (
                    <BaseSelect.Group key={group.label}>
                      <BaseSelect.GroupLabel className="px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-38">
                        {group.label}
                      </BaseSelect.GroupLabel>
                      {group.options.map((option) => (
                        <Item key={option.value} option={option} />
                      ))}
                    </BaseSelect.Group>
                  ))
                : all.map((option) => <Item key={option.value} option={option} />)}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

function Item<T extends string>({ option }: { option: Option<T> }) {
  return (
    <BaseSelect.Item
      value={option.value}
      className={cx(
        "flex h-8 cursor-default select-none items-center gap-2.5 rounded-[8px] px-2.5 text-base text-ink",
        "outline-none data-[highlighted]:bg-accent-soft",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <BaseSelect.ItemIndicator className="flex text-accent-text">
          <Icon name="check" size={14} />
        </BaseSelect.ItemIndicator>
      </span>
      {option.icon}
      <BaseSelect.ItemText className="flex-1 truncate">{option.label}</BaseSelect.ItemText>
      {option.note && <span className="shrink-0 text-sm text-ink-38">{option.note}</span>}
    </BaseSelect.Item>
  );
}
