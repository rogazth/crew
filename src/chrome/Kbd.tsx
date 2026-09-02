/** Keycap hint next to an action label. Pass "⌘⏎" style strings, one glyph per key. */
export function Kbd({ keys, className = "" }: { keys: string; className?: string }) {
  return (
    <kbd
      className={`inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border border-kumo-line bg-kumo-tint px-1 font-sans text-[10px] font-medium tracking-wide text-kumo-subtle ${className}`}
    >
      {keys}
    </kbd>
  );
}
