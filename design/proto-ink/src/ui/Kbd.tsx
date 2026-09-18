import { cx } from "@/lib/cx";

/**
 * A keycap is a level-0 chip, not a raised key — the elevation scale is for
 * things you can press, and this is a label.
 */
export function Kbd({ children, className }: { children: string; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-sm px-1",
        "bg-[var(--fill-tertiary)] font-sans text-micro leading-none text-tertiary",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function KbdRow({ chord, className }: { chord: string; className?: string }) {
  const parts = chord.includes("+") ? chord.split("+") : [...chord];
  return (
    <span className={cx("inline-flex items-center gap-[3px]", className)}>
      {parts.map((part, i) => (
        <Kbd key={`${part}-${i}`}>{part}</Kbd>
      ))}
    </span>
  );
}
