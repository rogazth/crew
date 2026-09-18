import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export type BadgeTone = "neutral" | "accent" | "attention" | "danger" | "success";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-[var(--fill-tertiary)] text-tertiary",
  accent: "bg-[var(--accent-fill)] text-[var(--accent)]",
  attention: "bg-[var(--attention-fill)] text-[var(--status-attention)]",
  danger: "bg-[var(--danger-fill)] text-[var(--status-danger)]",
  success: "bg-[var(--success-fill)] text-[var(--status-success)]",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-[18px] items-center gap-1 rounded-sm px-1.5 text-micro leading-none",
        "font-[var(--weight-medium)] whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
