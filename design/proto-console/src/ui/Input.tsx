import clsx from "clsx";
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";

const SHELL =
  "w-full rounded-[var(--r)] border border-rule bg-sunken px-2 text-md text-ink " +
  "placeholder:text-ink-4 focus-within:border-accent focus:border-accent " +
  "transition-colors duration-[var(--fast)]";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  mono?: boolean;
  invalid?: boolean;
  /** React 19 passes `ref` as an ordinary prop; the type has to say so. */
  ref?: Ref<HTMLInputElement>;
};

export function Input({ className, mono, invalid, ref, ...rest }: InputProps) {
  return (
    <input
      ref={ref}
      className={clsx(
        SHELL,
        "h-[var(--control-h)]",
        mono && "font-mono text-sm",
        invalid && "border-red focus:border-red",
        className,
      )}
      {...rest}
    />
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  mono?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
};

export function Textarea({ className, mono, rows = 4, ref, ...rest }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={clsx(SHELL, "resize-none py-1.5 leading-[var(--lh-md)]", mono && "font-mono text-sm", className)}
      {...rest}
    />
  );
}

/** An input with a fixed leading mark — the sidebar search, the palette. */
export function InputWith({
  lead,
  trail,
  className,
  children,
}: {
  lead?: ReactNode;
  trail?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={clsx(
        "flex items-center gap-2 rounded-[var(--r)] border border-rule bg-sunken px-2",
        "h-[var(--control-h)] focus-within:border-accent transition-colors duration-[var(--fast)]",
        className,
      )}
    >
      {lead ? <span className="shrink-0 text-ink-4">{lead}</span> : null}
      {children}
      {trail ? <span className="shrink-0">{trail}</span> : null}
    </div>
  );
}
