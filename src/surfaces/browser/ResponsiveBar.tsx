import { LaptopIcon, SmartphoneIcon, TabletIcon, XIcon, type LucideIcon as Icon } from "lucide-react";
import { useRef, useState } from "react";
import {
  VIEWPORT_PRESETS,
  clampSide,
  preset,
  presetOf,
  type PresetId,
  type Viewport,
} from "../../lib/browser/viewport";

const ICONS: Record<PresetId, Icon> = { phone: SmartphoneIcon, tablet: TabletIcon, laptop: LaptopIcon };

type Props = {
  viewport: Viewport;
  onChange: (viewport: Viewport) => void;
  onClose: () => void;
};

/** Under the toolbar while the page is held to a fixed size: presets and the exact size. */
export function ResponsiveBar({ viewport, onChange, onClose }: Props) {
  const active = presetOf(viewport);
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-canvas px-2 text-[12px]">
      {VIEWPORT_PRESETS.map((item) => {
        const Glyph = ICONS[item.id];
        const on = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(preset(item.id))}
            className={`flex h-6 items-center gap-1.5 rounded-md px-2 transition-colors ${
              on ? "bg-selected text-text" : "text-icon hover:bg-hover hover:text-text"
            }`}
          >
            <Glyph className="size-3.5" />
            {item.label}
          </button>
        );
      })}
      <span className="mx-1 h-4 w-px bg-border" />
      <Side label="Width" value={viewport.width} onCommit={(width) => onChange({ ...viewport, width })} />
      <span className="text-placeholder">×</span>
      <Side label="Height" value={viewport.height} onCommit={(height) => onChange({ ...viewport, height })} />
      <span className="flex-1" />
      <button
        type="button"
        aria-label="Fill the pane"
        title="Fill the pane"
        onClick={onClose}
        className="flex size-6 items-center justify-center rounded-md text-icon transition-colors hover:bg-hover hover:text-text"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** A side of the size, typed in and applied on Enter or blur; Escape puts the old value back. */
function Side({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs too, and the blur must not apply what Escape threw away.
  const discard = useRef(false);
  const commit = () => {
    if (draft !== null && !discard.current) onCommit(clampSide(Number(draft), value));
    discard.current = false;
    setDraft(null);
  };
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          discard.current = true;
          event.currentTarget.blur();
        }
      }}
      className="h-6 w-14 rounded-md bg-card px-1.5 text-center text-text tabular-nums outline-none ring-1 ring-transparent focus:bg-canvas focus:ring-border-strong"
    />
  );
}
