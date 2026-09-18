import { cx } from "@/lib/cx";

/** A keycap. Always renders the platform chord string it was handed. */
export function Kbd({ children, className, tone = "default" }: { children: string; className?: string; tone?: "default" | "on-accent" }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-1.5",
        "font-sans text-xs font-medium tabular-nums",
        tone === "on-accent"
          ? "bg-[oklch(1_0_0_/_0.18)] text-[var(--ink-on-accent)]"
          : "bg-sunken text-ink-52 shadow-[inset_0_-1px_0_var(--line)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function KbdRow({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}
