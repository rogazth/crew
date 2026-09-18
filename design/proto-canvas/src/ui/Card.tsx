import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "@/lib/cx";

/** A resting card: e1, radius 14, on the base surface. Nothing stacks twice. */
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-card bg-raised el-1", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHead({
  children,
  className,
  right,
}: {
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex h-9 items-center gap-2 border-b border-[var(--line-soft)] px-3 text-sm text-ink-52",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {right}
    </div>
  );
}

export function Chip({
  children,
  onClick,
  active,
  className,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
  title?: string;
}) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      title={title}
      className={cx(
        "inline-flex h-7 max-w-full items-center gap-1.5 rounded-chip px-2 text-sm",
        onClick && "rise-1 cursor-pointer",
        active ? "bg-accent-soft text-accent-text el-1" : "bg-raised text-ink-70 el-1",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
