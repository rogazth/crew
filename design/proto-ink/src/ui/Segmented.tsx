import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: IconName;
  count?: number;
};

/**
 * Level 0 throughout: the track is a recess, the thumb is a plain fill. A raised
 * thumb here would be the only control in the app with two elevations at once.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
}: {
  value: T;
  onChange: (next: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="tablist"
      className={cx(
        "inline-flex items-center gap-0.5 rounded-md bg-[var(--fill-quaternary)] p-0.5",
        "hairline-soft",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-sm px-2 whitespace-nowrap",
              "transition-colors duration-[var(--dur-2)]",
              size === "sm" ? "h-5 text-micro" : "h-6 text-body",
              active
                ? "bg-[var(--surface-canvas)] text-primary e1"
                : "text-tertiary hover:text-secondary",
            )}
          >
            {option.icon && <Icon name={option.icon} size={14} />}
            {option.label}
            {option.count !== undefined && (
              <span className="text-quaternary tnum">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
