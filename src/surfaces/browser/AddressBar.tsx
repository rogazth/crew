import { ClockCounterClockwiseIcon, GlobeIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react";
import * as api from "../../lib/api";
import { buildSuggestions, type Suggestion } from "../../lib/browser/suggest";
import { displayUrl, resolveAddress } from "../../lib/browser/url";

export type AddressBarHandle = {
  focus(): void;
  /** The page took focus: a click inside the guest never reaches this document, so nothing else closes the list. */
  dismiss(): void;
};

type Props = {
  ref: Ref<AddressBarHandle>;
  url: string;
  searchTemplate: string;
  onNavigate: (url: string) => void;
  /** Escape with nothing to close hands the keyboard back to the page. */
  onLeave: () => void;
};

/** The guest can take focus back a frame after we take it, so ⌘L keeps asking for a few frames. */
const FOCUS_FRAMES = 6;
const SUGGESTIONS = 8;

export function AddressBar({ ref, url, searchTemplate, onNavigate, onLeave }: Props) {
  const input = useRef<HTMLInputElement>(null);
  // null while the bar shows the page's URL; what was typed while it has focus.
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<{ url: string; title: string }[]>([]);
  const [cursor, setCursor] = useState(-1);
  const asked = useRef(0);

  const value = draft ?? displayUrl(url);
  const rows = open ? buildSuggestions(value, resolveAddress(value, searchTemplate), history, SUGGESTIONS) : [];

  useImperativeHandle(ref, () => ({
    focus() {
      let frame = 0;
      const attempt = () => {
        const el = input.current;
        if (!el) return;
        if (document.activeElement !== el) {
          el.focus();
          el.select();
        }
        if (++frame < FOCUS_FRAMES) requestAnimationFrame(attempt);
      };
      attempt();
    },
    dismiss: () => setOpen(false),
  }));

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [open]);

  function suggest(text: string) {
    const ask = ++asked.current;
    void api
      .browserHistorySuggest(text, SUGGESTIONS)
      .then((entries) => {
        // Typing outruns the daemon now and then; only the newest answer counts.
        if (ask === asked.current) setHistory(entries.map((entry) => ({ url: entry.url, title: entry.title })));
      })
      .catch(() => {});
  }

  function go(target: string) {
    setDraft(null);
    setOpen(false);
    setCursor(-1);
    onNavigate(target);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor((at) => Math.max(-1, Math.min(rows.length - 1, at + step)));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = cursor >= 0 ? rows[cursor] : undefined;
      if (picked) return go(picked.url);
      const address = resolveAddress(value, searchTemplate);
      if (address.kind !== "empty") go(address.url);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (open && rows.length > 0) {
        setOpen(false);
        return;
      }
      setDraft(null);
      onLeave();
    }
  }

  return (
    <div className="relative min-w-0 flex-1" data-tauri-drag-region="false">
      <input
        ref={input}
        value={value}
        aria-label="Address"
        placeholder="Search or enter address"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onMouseDown={(event) => {
          // The first click takes the whole address, as ⌘L does; later clicks place the caret.
          if (document.activeElement === event.currentTarget) return;
          event.preventDefault();
          event.currentTarget.focus();
        }}
        onFocus={(event) => {
          event.currentTarget.select();
          // A blank tab offers recent pages straight away; a loaded one waits for typing.
          if (!value) {
            setOpen(true);
            suggest("");
          }
        }}
        // Leaving the bar gives it back to the page's URL, so a navigation never lands behind stale text.
        onBlur={() => {
          setOpen(false);
          setDraft(null);
        }}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          setCursor(-1);
          setOpen(true);
          suggest(text);
        }}
        onKeyDown={onKeyDown}
        className="h-7 w-full rounded-chrome bg-card px-2.5 text-[13px] text-text outline-none ring-1 ring-transparent transition-[background-color,box-shadow] duration-150 placeholder:text-placeholder focus:bg-canvas focus:ring-border-strong"
      />
      {rows.length > 0 && (
        <div
          role="listbox"
          aria-label="Suggestions"
          className="absolute top-full right-0 left-0 z-20 mt-1 rounded-lg bg-kumo-control p-1 shadow-lg ring ring-kumo-line"
        >
          {rows.map((row, at) => (
            <Row
              key={`${row.kind}:${row.url}`}
              row={row}
              active={at === cursor}
              onHover={() => setCursor(at)}
              onPick={() => go(row.url)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const ICON = "size-3.5 shrink-0 text-text-muted";

function Row({
  row,
  active,
  onHover,
  onPick,
}: {
  row: Suggestion;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const icon =
    row.kind === "search" ? (
      <MagnifyingGlassIcon className={ICON} />
    ) : row.kind === "go" ? (
      <GlobeIcon className={ICON} />
    ) : (
      <ClockCounterClockwiseIcon className={ICON} />
    );
  const detail = row.kind === "history" && row.title.trim() ? row.url : null;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      // Keeps focus in the input, so the click lands before blur closes the list.
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onHover}
      onClick={onPick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] ${
        active ? "bg-selected text-text" : "text-text-muted"
      }`}
    >
      {icon}
      <span className="shrink-0 truncate text-text">{row.label}</span>
      {detail && <span className="min-w-0 truncate text-[12px] opacity-60">{detail}</span>}
    </button>
  );
}
