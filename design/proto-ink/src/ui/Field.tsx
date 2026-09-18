import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-small font-[var(--weight-medium)] text-secondary">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-micro text-[var(--status-danger)]">{error}</p>
      ) : hint ? (
        <p className="text-micro text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}

/** The settings row shape the user asked to keep: label + description, control right. */
export function SettingRow({
  label,
  description,
  control,
  className,
  stacked,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
  stacked?: boolean;
}) {
  return (
    <div
      className={cx(
        "flex gap-6 px-3.5 py-3",
        stacked ? "flex-col gap-2" : "items-center justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-body text-primary">{label}</div>
        {description && <div className="mt-0.5 text-small text-tertiary">{description}</div>}
      </div>
      <div className={cx("shrink-0", stacked && "w-full")}>{control}</div>
    </div>
  );
}

export function Card({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
}) {
  return (
    <section className={cx("flex flex-col gap-2", className)}>
      {title && (
        <h2 className="px-1 text-small font-[var(--weight-medium)] uppercase tracking-[0.06em] text-quaternary">
          {title}
        </h2>
      )}
      <div className="overflow-hidden rounded-card bg-chrome hairline [&>*+*]:border-t [&>*+*]:border-[var(--stroke-tertiary)]">
        {children}
      </div>
    </section>
  );
}
