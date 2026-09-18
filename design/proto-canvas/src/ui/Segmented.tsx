import { cx } from "@/lib/cx";

export type SegmentedOption<T extends string> = { value: T; label: string; count?: number };

/**
 * The selected segment is a raised card sliding on a sunken track — the same
 * relationship the active tab has with the tab bar.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cx(
        "inline-flex items-center gap-0.5 rounded-control bg-sunken p-0.5",
        "shadow-[inset_0_1px_2px_rgb(var(--shadow-ink)/0.05)]",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cx(
              "rise-1 inline-flex items-center gap-1.5 rounded-[8px] font-medium",
              size === "sm" ? "h-6 px-2 text-sm" : "h-7 px-2.5 text-base",
              active ? "bg-raised text-ink el-1" : "text-ink-52 hover:text-ink",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={cx("text-xs tabular-nums", active ? "text-ink-38" : "text-ink-38")}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
