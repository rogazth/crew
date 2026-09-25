/** One worktree's colour, shared by its tabs' chips. */
export function BranchDot({ hue, className = "size-2" }: { hue: number; className?: string }) {
  return <span aria-hidden className={`${className} shrink-0 rounded-full`} style={{ background: `oklch(68% 0.14 ${hue})` }} />;
}
