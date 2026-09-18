import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Icon, type GlyphName } from "./Icon";

export type ButtonVariant = "primary" | "default" | "ghost" | "danger" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-sm gap-1.5 rounded-chip",
  md: "h-9 px-3.5 text-base gap-2 rounded-control",
  lg: "h-10 px-4 text-base gap-2 rounded-control",
};

/**
 * Every variant with a resting surface sits at e2 and obeys the same press
 * behaviour; `ghost` and `quiet` have no surface, so they move colour instead.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent el-2 rise hover:bg-accent-hover active:bg-[var(--accent-press)] font-medium",
  default: "bg-raised text-ink el-2 rise hover:bg-raised-2",
  danger: "bg-danger text-[var(--danger-ink)] el-2 rise hover:brightness-110 font-medium",
  ghost: "bg-transparent text-ink-70 rise-1 hover:bg-accent-soft hover:text-ink",
  quiet: "bg-sunken text-ink-70 rise-1 hover:bg-raised hover:text-ink",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: GlyphName;
  trailing?: ReactNode;
  block?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon, trailing, block, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        "inline-flex select-none items-center justify-center whitespace-nowrap",
        "disabled:pointer-events-none disabled:opacity-45",
        SIZE[size],
        VARIANT[variant],
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
      {trailing}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: GlyphName;
    label: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
  }
>(function IconButton({ icon, label, variant = "ghost", size = "md", className, ...rest }, ref) {
  const box = size === "sm" ? "size-7 rounded-chip" : size === "lg" ? "size-10 rounded-control" : "size-9 rounded-control";
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "inline-grid shrink-0 place-items-center disabled:pointer-events-none disabled:opacity-45",
        box,
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 14 : 16} />
    </button>
  );
});
