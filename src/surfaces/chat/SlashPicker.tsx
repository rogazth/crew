import { useEffect, useRef } from "react";
import type { CommandEntry } from "../../lib/protocol";
import { pickerStyle } from "./usePickerAnchor";

type Props = {
  results: CommandEntry[];
  active: number;
  onHover: (index: number) => void;
  onPick: (entry: CommandEntry) => void;
  /** Where its trigger sits, from the well's left edge. */
  left?: number | null;
};

/** Sits above the well while a `/` is being typed. The keyboard lives in the composer. */
export function SlashPicker({ results, active, onHover, onPick, left }: Props) {
  const list = useRef<HTMLDivElement>(null);

  // The arrows walk a list longer than the popover shows.
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div role="listbox" aria-label="Commands" className="crew-popover crew-picker crew-picker-wide" style={pickerStyle(left)}>
      <div ref={list} className="max-h-72 overflow-y-auto">
        {results.map((entry, index) => (
          <button
            key={entry.name}
            type="button"
            role="option"
            data-index={index}
            aria-selected={index === active}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(entry)}
            className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] ${index === active ? "bg-hover" : ""}`}
          >
            <span className="shrink-0">/{entry.name}</span>
            {entry.argumentHint && <span className="shrink-0 text-text-muted">{entry.argumentHint}</span>}
            <span className="min-w-0 flex-1 truncate text-text-muted">{entry.description}</span>
            {entry.kind === "skill" && <span className="shrink-0 text-[11px] text-text-muted">skill</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
