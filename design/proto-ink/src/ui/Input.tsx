import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  icon?: IconName;
  trailing?: ReactNode;
  invalid?: boolean;
  size?: "sm" | "md" | "lg";
};

const HEIGHT = { sm: "h-6", md: "h-7", lg: "h-9" } as const;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, trailing, invalid, className, size = "md", ...rest },
  ref,
) {
  return (
    <div
      data-invalid={invalid || undefined}
      className={cx(
        "group relative flex items-center gap-1.5 rounded-md bg-canvas px-2",
        "e1 transition-shadow duration-[var(--dur-2)]",
        "focus-within:shadow-[var(--elev-1),inset_0_0_0_1px_var(--stroke-primary)]",
        "data-[invalid]:shadow-[var(--elev-1),inset_0_0_0_1px_var(--danger-stroke)]",
        HEIGHT[size],
        className,
      )}
    >
      {icon && <Icon name={icon} size={14} className="shrink-0 text-icon-faint" />}
      <input
        ref={ref}
        className="peer min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-quaternary"
        {...rest}
      />
      {trailing}
    </div>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      data-invalid={invalid || undefined}
      className={cx(
        "w-full resize-none rounded-md bg-canvas px-2 py-1.5 text-body text-primary outline-none",
        "e1 transition-shadow duration-[var(--dur-2)] placeholder:text-quaternary",
        "focus:shadow-[var(--elev-1),inset_0_0_0_1px_var(--stroke-primary)]",
        "data-[invalid]:shadow-[var(--elev-1),inset_0_0_0_1px_var(--danger-stroke)]",
        "ink-scroll",
        className,
      )}
      {...rest}
    />
  );
});
