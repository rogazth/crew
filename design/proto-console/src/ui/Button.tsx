import clsx from "clsx";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** React 19 passes `ref` as an ordinary prop; the type has to say so. */
  ref?: Ref<HTMLButtonElement>;
  /** A trailing keycap, right-aligned, dim. */
  kbd?: ReactNode;
  icon?: ReactNode;
  block?: boolean;
};

const VARIANT: Record<ButtonVariant, string> = {
  // A button is grey. Emphasis is inversion, never colour.
  default: "border border-rule bg-raised text-ink hover:border-rule-strong hover:bg-sunken",
  primary: "border border-ink bg-ink text-on-ink hover:opacity-90",
  ghost: "border border-transparent text-ink-2 hover:bg-raised hover:text-ink",
  danger: "border border-rule bg-raised text-red-ink hover:border-red hover:bg-red-wash",
};

export function Button({
  variant = "default",
  kbd,
  icon,
  block,
  className,
  children,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        "inline-flex h-[var(--control-h)] shrink-0 items-center gap-2 rounded-[var(--r)] px-2",
        "text-md select-none transition-colors duration-[var(--fast)]",
        "disabled:pointer-events-none disabled:opacity-40",
        block && "w-full",
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {icon ? <span className="shrink-0 opacity-70">{icon}</span> : null}
      <span className="truncate">{children}</span>
      {kbd ? <span className="ml-auto shrink-0 pl-2 opacity-60">{kbd}</span> : null}
    </button>
  );
}

/** A square icon-only button, sized to the control height. */
export function IconButton({
  className,
  children,
  variant = "ghost",
  label,
  ref,
  ...rest
}: Omit<ButtonProps, "kbd" | "icon" | "block"> & { label: string }) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        "inline-grid size-[var(--control-h)] shrink-0 place-items-center rounded-[var(--r)]",
        "transition-colors duration-[var(--fast)] disabled:pointer-events-none disabled:opacity-40",
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
