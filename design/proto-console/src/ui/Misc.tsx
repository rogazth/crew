import clsx from "clsx";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

export function Badge({
  children,
  tone = "default",
  className,
}: {
  children: ReactNode;
  tone?: "default" | "amber" | "red" | "green" | "accent";
  className?: string;
}) {
  const TONE = {
    default: "border-rule text-ink-3",
    amber: "border-amber text-amber-ink",
    red: "border-red text-red-ink",
    green: "border-green text-green-ink",
    accent: "border-accent text-accent-ink",
  } as const;
  return (
    <span
      className={clsx(
        "inline-flex h-4 items-center rounded-[var(--r)] border px-1 font-mono text-xs leading-none whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className, children, ...rest }, ref) {
    return (
      <div ref={ref} className={clsx("scroll", className)} {...rest}>
        {children}
      </div>
    );
  },
);

/** A tab row inside a surface — not the window's tab strip. */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: Array<{ id: T; label: ReactNode }>;
  onChange: (next: T) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={clsx("flex items-stretch gap-0", className)}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(option.id)}
            className={clsx(
              "-mb-px border-b px-2 py-1 font-mono text-sm transition-colors duration-[var(--fast)]",
              active ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink-2",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Empty states are sentences, not illustrations. */
export function Empty({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-md text-ink-2">{title}</p>
      {hint ? <p className="max-w-[46ch] text-sm text-ink-4">{hint}</p> : null}
      {children}
    </div>
  );
}

export function Hairline({ className }: { className?: string }) {
  return <div className={clsx("h-px shrink-0 bg-rule", className)} />;
}
