import type { OutlineItem } from "../../lib/markdown/outline";

type Props = {
  items: OutlineItem[];
  /** The start of the heading whose section is at the top of the pane. */
  active: number | null;
  onSelect: (item: OutlineItem) => void;
};

/** The note's headings beside it, indented by level; a click scrolls there. */
export function Outline({ items, active, onSelect }: Props) {
  // Indent relative to the shallowest level used, so a note of only `##` is not pushed right.
  const base = Math.min(...items.map((item) => item.level));

  return (
    <nav aria-label="Outline" className="w-56 shrink-0 overflow-y-auto border-l border-border px-2 py-3">
      <h2 className="px-2 pb-2 text-[11px] font-medium text-text-muted">Outline</h2>
      {items.length === 0 ? (
        <p className="px-2 text-[12px] text-placeholder">No headings</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => (
            <li key={item.from}>
              <button
                type="button"
                onClick={() => onSelect(item)}
                aria-current={item.from === active ? "location" : undefined}
                style={{ paddingLeft: `${8 + (item.level - base) * 12}px` }}
                className="w-full truncate rounded-md py-1 pr-2 text-left text-[12.5px] text-text-muted hover:bg-hover hover:text-text aria-[current=location]:text-text aria-[current=location]:font-medium"
                title={item.text}
              >
                {item.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
