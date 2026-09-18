import { cx } from "@/lib/cx";

/**
 * The spinner replacement. Three dots that breathe: it says "someone is
 * working", where a spinner says "this page has not loaded".
 */
export function Pulse({ className, label }: { className?: string; label?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)} role="status" aria-label={label ?? "Working"}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="pulse-dot size-1.5 rounded-full bg-current"
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}
