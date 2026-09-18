import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export type BadgeTone = "neutral" | "accent" | "warn" | "danger" | "ok";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-ink-52",
  accent: "bg-accent-soft text-accent-text",
  warn: "bg-warn-soft text-[var(--warn)]",
  danger: "bg-danger-soft text-[var(--danger)]",
  ok: "bg-ok-soft text-[var(--ok)]",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center gap-1 rounded-chip px-1.5 text-xs font-medium",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
