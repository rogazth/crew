/** One worktree's colour, shared by its tabs' chips. */
export function BranchDot({ hue, className = "size-2" }: { hue: number; className?: string }) {
  return <span aria-hidden className={`${className} shrink-0 rounded-full`} style={{ background: `oklch(68% 0.14 ${hue})` }} />;
}

/** A worktree's name on a tab, as a small tag in its colour. */
export function BranchTag({ hue, label, className = "" }: { hue: number; label: string; className?: string }) {
  return (
    <span
      className={`${className} min-w-0 shrink-0 truncate rounded-[5px] px-1.5 py-px text-[11px] leading-4 text-text`}
      style={{ background: `oklch(68% 0.14 ${hue} / 0.18)` }}
    >
      {label}
    </span>
  );
}
