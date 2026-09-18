import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cx } from "@/lib/cx";

const FIELD =
  "w-full bg-raised text-ink placeholder:text-ink-38 el-2 rounded-control " +
  "transition-shadow duration-[120ms] focus:outline-none focus:shadow-[var(--e2),0_0_0_3px_var(--ring)]";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { leading?: ReactNode; trailing?: ReactNode }
>(function Input({ className, leading, trailing, ...rest }, ref) {
  if (leading || trailing) {
    return (
      <div
        className={cx(
          FIELD,
          "flex h-9 items-center gap-2 px-2.5 focus-within:shadow-[var(--e2),0_0_0_3px_var(--ring)]",
          className,
        )}
      >
        {leading}
        <input
          ref={ref}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-ink-38"
          {...rest}
        />
        {trailing}
      </div>
    );
  }
  return <input ref={ref} className={cx(FIELD, "h-9 px-3 text-base", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(FIELD, "resize-none px-3 py-2 text-base", className)} {...rest} />;
  },
);
