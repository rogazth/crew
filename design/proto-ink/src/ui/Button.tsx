import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";

export type ButtonTone = "default" | "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  size?: ButtonSize;
  icon?: IconName;
  trailing?: ReactNode;
  block?: boolean;
  selected?: boolean;
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-6 gap-1 px-2 text-micro rounded-md",
  md: "h-7 gap-1.5 px-2.5 text-body rounded-md",
  lg: "h-9 gap-2 px-3.5 text-body rounded-row",
};

/**
 * Elevation level 1 is the whole story for a resting control: one shadow plus an
 * inset hairline, never a border. Ghost and selected stay at level 0 so a row of
 * them does not read as a row of chips.
 *
 * There is deliberately no accent-filled button: accent means "you are here",
 * and a button is not a place. The primary action is ink.
 */
const TONE: Record<ButtonTone, string> = {
  default:
    "bg-chrome text-primary e1 hover:bg-[var(--fill-quaternary)] active:bg-[var(--fill-tertiary)]",
  primary:
    "bg-[var(--ink)] text-[var(--surface-canvas)] shadow-[0_1px_2px_color-mix(in_oklch,var(--ink)_18%,transparent)] hover:opacity-90 active:opacity-80",
  ghost:
    "bg-transparent text-secondary hover:bg-[var(--fill-tertiary)] hover:text-primary active:bg-[var(--fill-secondary)]",
  danger:
    "bg-[var(--status-danger)] text-[var(--accent-contrast)] shadow-[0_1px_2px_color-mix(in_oklch,var(--ink)_14%,transparent)] hover:opacity-90",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = "default", size = "md", icon, trailing, block, selected, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      data-selected={selected || undefined}
      className={cx(
        "inline-flex select-none items-center justify-center whitespace-nowrap",
        "transition-[background-color,opacity,box-shadow,color] duration-[var(--dur-2)]",
        "disabled:pointer-events-none disabled:opacity-40",
        SIZE[size],
        TONE[tone],
        selected && "bg-[var(--fill-secondary)] text-primary",
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} className="-ml-0.5 shrink-0 opacity-80" />}
      {children}
      {trailing}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonProps, "icon" | "children"> & {
  icon: IconName;
  label: string;
  iconSize?: number;
};

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: "size-5 rounded-sm",
  md: "size-6 rounded-md",
  lg: "size-7 rounded-md",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, tone = "ghost", size = "md", iconSize, className, selected, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      data-selected={selected || undefined}
      className={cx(
        "inline-flex shrink-0 items-center justify-center",
        "transition-[background-color,opacity,color] duration-[var(--dur-2)]",
        "disabled:pointer-events-none disabled:opacity-40",
        ICON_SIZE[size],
        TONE[tone],
        selected && "bg-[var(--fill-secondary)] text-primary",
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? (size === "sm" ? 14 : 16)} />
    </button>
  );
});
