import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * The transcript is a two-column log. The rule between the gutter and the
 * content is painted once, by the container, so the gaps between rows do not
 * break it into dashes.
 */
export function LogColumn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "relative mx-auto w-full",
        "max-w-[calc(var(--log-gutter)+1px+var(--log-measure))]",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-px bg-rule"
        style={{ left: "var(--log-gutter)" }}
      />
      {children}
    </div>
  );
}

export type LogRowProps = {
  /** Left of the rule: who, when, or the verb. Never selectable. */
  gutter?: ReactNode;
  /** Right-aligned inside the gutter — a timestamp, usually. */
  stamp?: ReactNode;
  /** Takes the stamp's slot on hover, so nothing resizes. */
  action?: ReactNode;
  gap?: number;
  className?: string;
  gutterClassName?: string;
  contentClassName?: string;
  children: ReactNode;
  id?: string;
};

export function LogRow({
  gutter,
  stamp,
  action,
  gap = 0,
  className,
  gutterClassName,
  contentClassName,
  children,
  id,
}: LogRowProps) {
  return (
    <div
      id={id}
      style={gap ? { marginTop: gap } : undefined}
      className={clsx("group/row grid grid-cols-[var(--log-gutter)_1fr] items-start", className)}
    >
      <div
        className={clsx(
          "flex items-baseline gap-2 overflow-hidden pr-3 pl-2 font-mono text-xs leading-[var(--lh-md)] text-ink-4 select-none",
          gutterClassName,
        )}
      >
        {gutter ? <span className="truncate">{gutter}</span> : null}
        {stamp || action ? (
          <span className="ml-auto grid shrink-0 place-items-end">
            {stamp ? (
              <span
                className={clsx(
                  "col-start-1 row-start-1 tabular-nums",
                  action && "group-hover/row:opacity-0",
                )}
              >
                {stamp}
              </span>
            ) : null}
            {action ? (
              <span className="col-start-1 row-start-1 opacity-0 group-hover/row:opacity-100">
                {action}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className={clsx("min-w-0 pl-3", contentClassName)}>{children}</div>
    </div>
  );
}

/** A single log line: text left, result right, aligned to the column edge. */
export function LogLine({
  text,
  suffix,
  failed,
  mono,
  lead,
  trail,
  className,
}: {
  text: ReactNode;
  suffix?: ReactNode;
  failed?: boolean;
  mono?: boolean;
  lead?: ReactNode;
  trail?: ReactNode;
  className?: string;
}) {
  return (
    <span className={clsx("flex w-full items-baseline gap-2", className)}>
      {lead ? <span className="shrink-0">{lead}</span> : null}
      <span
        className={clsx(
          "min-w-0 truncate",
          mono ? "font-mono text-sm" : "text-md",
          failed ? "text-red-ink" : "text-ink-2",
        )}
      >
        {text}
      </span>
      {suffix ? (
        <span
          className={clsx(
            "ml-auto shrink-0 font-mono text-xs tabular-nums",
            failed ? "text-red-ink" : "text-ink-4",
          )}
        >
          {suffix}
        </span>
      ) : null}
      {trail ? <span className={clsx(suffix ? "" : "ml-auto", "shrink-0")}>{trail}</span> : null}
    </span>
  );
}
