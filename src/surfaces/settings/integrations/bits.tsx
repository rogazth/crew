// The page's small pieces: a state dot, pills with a sliding thumb, an
// account's name edited in place, a row's one fix, and a row's ⋯ menu.
import { EllipsisIcon, PenLineIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ActionMenu } from "../../../chrome/ActionMenu";
import { IconButton } from "../../../chrome/kit";
import type { MenuAction, MenuPoint } from "../../../lib/menu";
import { TONE_BG, type Tone } from "./lib";
import { actions, type Account } from "./store";

export function Dot({ tone, pulse = false, className = "size-1.5" }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={`relative inline-flex shrink-0 rounded-full ${TONE_BG[tone]} ${className}`}>
      {pulse && <span className={`absolute inset-0 rounded-full ${TONE_BG[tone]} motion-safe:animate-[c-ping_1.8s_var(--ease-out)_infinite]`} />}
    </span>
  );
}

export type PillOption<T extends string> = { value: T; label: ReactNode; icon?: ReactNode; count?: number | undefined; tone?: Tone | undefined };

/** Choices side by side with a thumb that slides to the one picked. */
export function Pills<T extends string>({
  value,
  options,
  onChange,
  label,
  small = false,
  className = "",
}: {
  value: T;
  options: PillOption<T>[];
  onChange: (value: T) => void;
  label: string;
  small?: boolean;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const on = wrap.current?.querySelector<HTMLElement>(`[data-pill="${CSS.escape(value)}"]`);
    const el = thumb.current;
    if (!on || !el) return;
    el.style.width = `${on.offsetWidth}px`;
    el.style.transform = `translateX(${on.offsetLeft}px)`;
    // The first placement doesn't slide in from the left edge.
    requestAnimationFrame(() => el.setAttribute("data-ready", ""));
  });
  return (
    <div ref={wrap} role="radiogroup" aria-label={label} className={`relative inline-flex items-center gap-0.5 rounded-full bg-card ${small ? "p-0.5" : "p-1"} ${className}`}>
      <span
        ref={thumb}
        aria-hidden
        className={`absolute left-0 rounded-full bg-surface ${small ? "top-0.5 bottom-0.5" : "top-1 bottom-1"} shadow-[0_0_0_1px_var(--color-hairline),0_1px_3px_oklch(0%_0_0/0.1)] data-ready:transition-[transform,width] data-ready:duration-300 data-ready:ease-[var(--ease-spring)] motion-reduce:transition-none!`}
      />
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-pill={option.value}
            onClick={() => onChange(option.value)}
            className={`relative z-[1] flex items-center gap-1.5 rounded-full whitespace-nowrap ${small ? "h-6 px-2.5 text-[12px]" : "h-7 px-3 text-[12.5px]"} outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 ${
              on ? "text-text" : "text-text-muted hover:text-text"
            }`}
          >
            {option.icon}
            {option.label}
            {option.count !== undefined && <span className={`tabular-nums ${on ? "text-text-muted" : "text-placeholder"}`}>{option.count}</span>}
            {option.tone && <Dot tone={option.tone} />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The account's name, as wide as its text: a click selects it and the text itself becomes editable. Enter saves,
 * Escape puts it back. Each new `edit` (a row's Rename) starts editing too.
 */
export function AccountName({ account, edit = 0 }: { account: Account; edit?: number }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!edit) return;
    // After the menu that asked has closed and handed focus back, so it doesn't blur the name right away.
    const timer = window.setTimeout(() => setEditing(true), 0);
    return () => window.clearTimeout(timer);
  }, [edit]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }, [editing]);
  const save = () => {
    const el = ref.current;
    const next = el?.textContent?.trim();
    if (next && next !== account.label) actions.rename(account.id, next);
    else if (el) el.textContent = account.label;
    setEditing(false);
  };
  return (
    // The pencil and the gap before it are part of the name: one pointer, one click.
    <span onClick={() => setEditing(true)} className={`group flex max-w-full min-w-0 items-center gap-1.5 self-start ${editing ? "" : "cursor-pointer"}`}>
      <span
        // Keyed by the name: a rename remounts it, so React never patches text the user typed over.
        key={account.label}
        ref={ref}
        role="textbox"
        aria-label="Account name"
        tabIndex={0}
        spellCheck={false}
        contentEditable={editing}
        suppressContentEditableWarning
        onFocus={() => setEditing(true)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            event.currentTarget.textContent = account.label;
            event.currentTarget.blur();
          }
        }}
        // Emptied while editing, the span keeps a line's height and a sliver of width, so the caret still shows.
        className={`min-w-0 font-medium outline-none ${editing ? "min-h-[1lh] min-w-[2px] cursor-text overflow-hidden whitespace-nowrap" : "truncate"}`}
      >
        {account.label}
      </span>
      {!editing && <PenLineIcon className="size-3 shrink-0 text-icon opacity-0 transition-opacity group-hover:opacity-100" />}
    </span>
  );
}

/** A row's one fix, in the blue the cards use for theirs. */
export function RowAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] font-medium text-info outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      {label}
    </button>
  );
}

/** A row's rarer actions behind ⋯, so the row itself keeps only its fix and its switch. Icons, no shortcuts. */
export function RowMenu({ label, actions: entries, onPick }: { label: string; actions: Omit<MenuAction, "hotkey">[]; onPick: (id: string) => void }) {
  const [point, setPoint] = useState<MenuPoint | null>(null);
  return (
    <>
      <IconButton
        icon={EllipsisIcon}
        label={label}
        className="size-7"
        onClick={(event) => {
          // Under the button, its right edges lined up with the row's.
          const rect = event.currentTarget.getBoundingClientRect();
          setPoint({ x: rect.right - 144, y: rect.bottom + 4 });
        }}
      />
      {point && (
        <ActionMenu
          point={point}
          compact
          actions={entries.map((entry) => ({ ...entry, hotkey: "" }))}
          onPick={(id) => {
            setPoint(null);
            onPick(id);
          }}
          onClose={() => setPoint(null)}
        />
      )}
    </>
  );
}
