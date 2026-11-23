import {
  BotIcon,
  CornerDownLeftIcon,
  GlobeIcon,
  HatGlassesIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  SearchIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { BotAvatar } from "../chrome/BotAvatar";
import { Kbd } from "../chrome/Kbd";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { useBrowserPrefs } from "../hooks/useBrowserPrefs";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { browserHistorySuggest } from "../lib/api";
import { blankRows, KIND_TITLES, SETUP_TITLE, type BlankRow, type Kind } from "../lib/blankTab";
import { holdBlankTab } from "../lib/blankTabFocus";
import type { HistoryEntry } from "../lib/protocol";
import { defaultModelOf, modelLabel, providerOf, type AgentChoice, type ProviderId } from "../lib/providers";
import type { Session } from "../lib/types";
import { SiteIcon } from "./chat/SiteIcon";
import { terminalView } from "./load";

/** What a pick in the blank tab asks of the app; the tab it opens takes the blank tab's seat. */
export type BlankPick =
  | { kind: "session"; choice: AgentChoice }
  | { kind: "existing"; session: Session }
  | { kind: "terminal" }
  | { kind: "browser"; url: string; incognito: boolean }
  | { kind: "bot" }
  /** No agent CLI installed: Settings, on its providers. */
  | { kind: "setup" };

type Props = {
  /** The pane's id, which ⌘T on this tab reaches it by. */
  paneId: string;
  visible: boolean;
  /** The workspace's sessions and bots, the never-used ones left out. */
  agents: readonly Session[];
  /** A pick that takes a while (a session being made) returns its promise: the row waits on it, and shows what failed. */
  onPick: (pick: BlankPick) => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Focus. A page or a terminal can take the keyboard back a frame after the
// tab comes up, so the field keeps asking for a few frames, as the address bar does.

const FOCUS_FRAMES = 6;

function focusSoon(field: RefObject<HTMLInputElement | null>, select: boolean): () => void {
  let frame = 0;
  let handle = 0;
  const attempt = () => {
    const el = field.current;
    if (!el) return;
    if (document.activeElement !== el) el.focus();
    if (select && frame === 0) el.select();
    if (++frame < FOCUS_FRAMES) handle = requestAnimationFrame(attempt);
  };
  attempt();
  return () => cancelAnimationFrame(handle);
}

// ---------------------------------------------------------------------------

/** The browser's history for `text`; null asks for nothing. Rows for an earlier text stay up until the new ones come. */
function usePages(text: string | null, limit: number): HistoryEntry[] {
  const [pages, setPages] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    if (text === null) return;
    let live = true;
    browserHistorySuggest(text, limit)
      .then((rows) => live && setPages(rows))
      .catch(() => live && setPages([]));
    return () => {
      live = false;
    };
  }, [text, limit]);
  return text === null ? [] : pages;
}

/** A pasted line break would vanish in a one-line field: it becomes a space instead. */
function pasteOneLine(event: ClipboardEvent<HTMLInputElement>) {
  const text = event.clipboardData.getData("text/plain");
  if (!/[\r\n]/.test(text)) return;
  event.preventDefault();
  const input = event.currentTarget;
  const flat = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  input.setRangeText(flat, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const providerName = (id: string) => providerOf(id)?.label ?? id;

/** "Opus 5.5": the model a pick runs, its provider's default when it names none. */
function modelName(choice: Pick<AgentChoice, "provider" | "model">): string {
  const model = choice.model || defaultModelOf(choice.provider);
  return model ? modelLabel(choice.provider, model) : "its default model";
}

const KIND_ICONS: Record<Kind, ReactNode> = {
  session: <MessageSquareIcon />,
  browser: <GlobeIcon />,
  terminal: <SquareTerminalIcon />,
  bot: <BotIcon />,
  incognito: <HatGlassesIcon />,
};

const KIND_HINTS: Record<Exclude<Kind, "session">, string> = {
  browser: "Search the web or open a page",
  terminal: "A shell, ready for commands",
  bot: "A named agent that keeps its history",
  incognito: "A throwaway page without your cookies",
};

/** Compact with nothing typed: the two kinds reached for least. */
const MINOR_KINDS = new Set<Kind>(["bot", "incognito"]);

type Option = { id: string; icon: ReactNode; title: string; hint: string; minor: boolean; pick: BlankPick };

export function BlankTab({ paneId, visible, agents, onPick }: Props) {
  const { effective, lastOf, installed } = useDefaultAgent();
  const { prefs } = useBrowserPrefs();
  const [text, setText] = useState("");
  // The row Enter runs, by id, so a row that arrives late never moves it; null is the first.
  const [chosen, setChosen] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => void terminalView.preload().catch(() => {}), []);
  useEffect(() => (visible ? focusSoon(field, false) : undefined), [visible]);
  useEffect(() => holdBlankTab(paneId, () => void focusSoon(field, true)), [paneId]);

  const typed = text.trim();
  const history = usePages(typed || null, 6);
  const choiceOf = (provider: ProviderId) => (provider === effective.provider ? effective : lastOf(provider));
  const rows = blankRows(text, { installed, choiceOf, agents, history, searchTemplate: prefs.searchTemplate });
  const options = rows.map((row, index) => present(row, typed ? index > 0 : row.kind === "new" && MINOR_KINDS.has(row.what)));
  const at = Math.max(0, chosen === null ? 0 : options.findIndex((option) => option.id === chosen));
  const active = options[at];

  function present(row: BlankRow, minor: boolean): Option {
    const base = { id: row.id, minor };
    switch (row.kind) {
      case "new":
        if (row.what === "session") {
          return { ...base, icon: KIND_ICONS.session, title: KIND_TITLES.session, hint: `${providerName(effective.provider)} ${modelName(effective)}`, pick: { kind: "session", choice: effective } };
        }
        return { ...base, icon: KIND_ICONS[row.what], title: KIND_TITLES[row.what], hint: KIND_HINTS[row.what], pick: kindPick(row.what) };
      case "setup":
        return { ...base, icon: KIND_ICONS.session, title: SETUP_TITLE, hint: "No agent CLI installed yet", pick: { kind: "setup" } };
      case "agent": {
        const { choice } = row;
        const icon = <ProviderIcon provider={choice.provider} className="size-[18px]" />;
        return row.by === "provider"
          ? { ...base, icon, title: providerName(choice.provider), hint: `New session with ${modelName(choice)}`, pick: { kind: "session", choice } }
          : { ...base, icon, title: modelName(choice), hint: `New session with ${providerName(choice.provider)}`, pick: { kind: "session", choice } };
      }
      case "existing": {
        const { session } = row;
        const bot = session.kind === "bot";
        return {
          ...base,
          icon: bot ? <BotAvatar seed={session.id} bare className="size-4" /> : <ProviderIcon provider={session.provider} className="size-4" />,
          title: session.name,
          hint: bot ? "Bot" : `${providerName(session.provider)} session`,
          pick: { kind: "existing", session },
        };
      }
      case "open":
        return { ...base, icon: <GlobeIcon />, title: row.title, hint: row.detail || "In a browser tab", pick: { kind: "browser", url: row.url, incognito: false } };
      case "search":
        return { ...base, icon: <SearchIcon />, title: "Search the web", hint: row.engine, pick: { kind: "browser", url: row.url, incognito: false } };
      case "page":
        return { ...base, icon: <SiteIcon url={row.url} globe />, title: row.title, hint: row.detail, pick: { kind: "browser", url: row.url, incognito: false } };
    }
  }

  /** ⌥ opens a page row in an incognito tab, as the launcher before it did; it shows nowhere, for whoever knows it. */
  function run(option: Option | undefined, incognito = false) {
    if (!option || pending !== null) return;
    setFailed(null);
    const { pick } = option;
    const result = onPick(incognito && pick.kind === "browser" ? { ...pick, incognito: true } : pick);
    if (!result) return;
    setPending(option.id);
    result
      .catch((error: unknown) => setFailed({ id: option.id, message: error instanceof Error ? error.message : String(error) }))
      .finally(() => setPending(null));
  }

  // The row Enter runs stays in view as the arrows walk past the list's edge.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at]);

  // Rows appear (and shift while filtering) under a still pointer, and the browser answers with mouse
  // events. Only a pointer that travelled may move the choice.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hoverAt = (id: string) => (event: MouseEvent) => {
    const last = pointer.current;
    pointer.current = { x: event.screenX, y: event.screenY };
    if (!last || (last.x === event.screenX && last.y === event.screenY)) return;
    setChosen(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (at + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      setChosen(options[next]?.id ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) run(active, event.altKey);
    } else if (event.key === "Escape" && text) {
      event.preventDefault();
      setText("");
      setChosen(null);
      setFailed(null);
    }
  };

  // A click on the page around the list puts the caret back: the field is the only thing here that types.
  const keepFocus = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("input")) return;
    event.preventDefault();
    field.current?.focus();
  };

  return (
    <div onMouseDown={keepFocus} className="flex h-full min-h-0 flex-col items-center overflow-y-auto px-6 pt-[14vh] pb-24">
      <div className="flex w-full max-w-[600px] flex-col gap-2">
        <div className="flex h-12 items-center gap-2 rounded-xl border border-border bg-surface pr-3 pl-3 focus-within:border-border-strong">
          <input
            ref={field}
            role="combobox"
            aria-label="Open a tab"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
            aria-autocomplete="list"
            value={text}
            spellCheck={false}
            autoComplete="off"
            readOnly={pending !== null}
            onChange={(event) => {
              setText(event.target.value);
              setChosen(null);
              setFailed(null);
            }}
            onKeyDown={onKeyDown}
            onPaste={pasteOneLine}
            placeholder="Search or type a URL"
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-placeholder"
          />
          <span aria-hidden className="flex shrink-0 gap-1">
            <Kbd keys="↑" />
            <Kbd keys="↓" />
          </span>
        </div>
        <div ref={list} id={listId} role="listbox" aria-label="New tab" className="flex flex-col gap-0.5 pt-1">
          {options.map((option, index) => (
            <OptionRow
              key={option.id}
              domId={`${listId}-${option.id}`}
              option={option}
              active={index === at}
              // A gap where the big rows end and the compact ones start.
              spaced={option.minor && index > 0 && !options[index - 1]?.minor}
              pending={pending === option.id}
              failed={failed?.id === option.id ? failed.message : null}
              onHover={hoverAt(option.id)}
              onPick={(event) => run(option, event.altKey)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function kindPick(kind: Exclude<Kind, "session">): BlankPick {
  if (kind === "browser") return { kind: "browser", url: "", incognito: false };
  if (kind === "incognito") return { kind: "browser", url: "", incognito: true };
  return { kind };
}

/** The square a big row's icon sits in, its own white over the row's hover so the two never stack. */
function Tile({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface text-icon ring-1 ring-hairline ring-inset [&>svg]:size-[18px] [&>svg]:stroke-[1.5]">
      {children}
    </span>
  );
}

/** One row. On, its line turns to body text and ↵ shows: it says what Enter does. */
function OptionRow({
  domId,
  option,
  active,
  spaced,
  pending,
  failed,
  onHover,
  onPick,
}: {
  domId: string;
  option: Option;
  active: boolean;
  spaced: boolean;
  pending: boolean;
  failed: string | null;
  onHover: (event: MouseEvent) => void;
  onPick: (event: MouseEvent) => void;
}) {
  const end = pending ? (
    <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-text-muted" />
  ) : (
    <CornerDownLeftIcon className={`size-3.5 shrink-0 text-text-muted ${active ? "" : "invisible"}`} />
  );
  const hint = failed ? `Couldn't start: ${failed}` : pending ? "Starting…" : option.hint;
  const line = failed ? "text-danger" : active ? "text-text" : "text-text-muted";
  const shared = {
    id: domId,
    role: "option",
    "aria-selected": active,
    // Keeps the caret in the field: the click still lands.
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
    onMouseMove: onHover,
    onClick: onPick,
  } as const;
  if (option.minor) {
    return (
      <div {...shared} className={`flex h-8 cursor-default items-center gap-3 rounded-lg px-3 ${active ? "bg-hover" : ""} ${spaced ? "mt-3" : ""}`}>
        <span className="grid w-9 shrink-0 place-items-center text-icon [&>img]:size-4 [&>svg]:size-4 [&>svg]:stroke-[1.5]">{option.icon}</span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="max-w-[60%] shrink-0 truncate text-[13.5px] text-text">{option.title}</span>
          <span className={`min-w-0 truncate text-[12.5px] ${line}`}>{hint}</span>
        </span>
        {end}
      </div>
    );
  }
  return (
    <div {...shared} className={`flex cursor-default items-center gap-3 rounded-xl px-3 py-2 ${active ? "bg-hover" : ""} ${spaced ? "mt-3" : ""}`}>
      <Tile>{option.icon}</Tile>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] leading-5 text-text">{option.title}</span>
        <span className={`truncate text-[12.5px] leading-[18px] ${line}`}>{hint}</span>
      </span>
      {end}
    </div>
  );
}
