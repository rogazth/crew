import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink-70">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-[var(--danger)]">{error}</p>
      ) : hint ? (
        <p className="text-sm text-ink-52">{hint}</p>
      ) : null}
    </div>
  );
}

/** A settings row: label + description left, control right, hairline between. */
export function Row({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center justify-between gap-6 px-4 py-3.5",
        "border-b border-[var(--line-soft)] last:border-b-0",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-base text-ink">{label}</div>
        {description && <div className="mt-0.5 text-sm text-ink-52">{description}</div>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-2.5 flex items-end justify-between gap-4 px-1">
        <div>
          <h2 className="text-md font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-52">{description}</p>}
        </div>
        {action}
      </div>
      <div className="overflow-hidden rounded-card bg-raised el-1">{children}</div>
    </section>
  );
}
