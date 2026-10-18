// PROTOTYPE — throwaway. The floating bar that flips between variants:
// ← and → (or the arrows here) step through them, and the choice lives in
// `?variant=` so a reload or a shared link keeps it.
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect } from "react";

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
  keys = true,
}: {
  variants: readonly { key: string; name: string }[];
  current: string;
  onChange: (key: string) => void;
  /** Off over the real app, where ← and → already mean something. */
  keys?: boolean;
}) {
  const index = Math.max(0, variants.findIndex((v) => v.key === current));
  const step = (by: number) => onChange(variants[(index + by + variants.length) % variants.length]!.key);

  useEffect(() => {
    if (!keys) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (!import.meta.env.DEV) return null;
  const v = variants[index]!;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#111] px-1.5 py-1 text-[12.5px] text-white shadow-xl ring-1 ring-white/10">
      <button type="button" onClick={() => step(-1)} className="grid size-7 place-items-center rounded-full hover:bg-white/10" aria-label="Previous variant">
        <ChevronLeftIcon className="size-4" />
      </button>
      <span className="px-2 tabular-nums">
        {v.key} <span className="text-white/60">({v.name})</span>
      </span>
      <button type="button" onClick={() => step(1)} className="grid size-7 place-items-center rounded-full hover:bg-white/10" aria-label="Next variant">
        <ChevronRightIcon className="size-4" />
      </button>
    </div>
  );
}
