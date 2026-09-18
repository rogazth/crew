import clsx from "clsx";
import type { ReactNode } from "react";

/** A labelled control in a form: label above, description under, control below. */
export function Field({
  label,
  description,
  error,
  htmlFor,
  className,
  children,
}: {
  label: string;
  description?: string;
  error?: string | null;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="font-mono text-xs tracking-wide text-ink-3 uppercase select-none"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-red-ink">{error}</p>
      ) : description ? (
        <p className="text-sm text-ink-3">{description}</p>
      ) : null}
    </div>
  );
}

/**
 * The settings shape the user asked to keep: a rounded card of rows separated by
 * hairlines, each row `label + description` left, control right.
 */
export function Card({
  title,
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={clsx("flex flex-col gap-2", className)}>
      {title ? (
        <h2 className="font-mono text-xs tracking-wide text-ink-3 uppercase">{title}</h2>
      ) : null}
      <div className="overflow-hidden rounded-[var(--r)] border border-rule bg-raised">
        {children}
      </div>
    </section>
  );
}

export function Row({
  label,
  description,
  control,
  className,
  stacked,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  className?: string;
  stacked?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex gap-4 border-b border-rule px-3 py-2 last:border-b-0",
        stacked ? "flex-col" : "items-center justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-md text-ink">{label}</div>
        {description ? <div className="text-sm text-ink-3">{description}</div> : null}
      </div>
      {control ? <div className={clsx("shrink-0", stacked && "w-full")}>{control}</div> : null}
    </div>
  );
}
