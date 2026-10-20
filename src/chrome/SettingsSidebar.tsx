// The settings nav: a search that finds pages and single settings (Enter lands
// on the row and lights it), and the pages grouped by what they govern.
import { ArrowDownToLineIcon, ArrowLeftIcon, CornerDownLeftIcon, RotateCwIcon, SearchIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useProviderAttention } from "../hooks/useProviderStatus";
import { useUpdateActions, useUpdateState } from "../hooks/useUpdate";
import type { SettingsSectionId } from "../lib/settings";
import { NAV_GROUPS, PAGES, PENDING, settingsIndex, type IndexEntry } from "../surfaces/settings/pages";
import { useSectionRequests } from "../surfaces/settings/route";
import { requestJump } from "../surfaces/settings/ui";

type Props = {
  section: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  /** Back to the sessions sidebar. */
  onClose: () => void;
};

type Result = { kind: "page"; page: SettingsSectionId } | { kind: "setting"; entry: IndexEntry };

/** Slides over the session panel while settings are open; the rail stays beside it. */
export function SettingsSidebar({ section, onSelect, onClose }: Props) {
  // A page can send the nav elsewhere, like an Environments card's "Manage providers".
  useSectionRequests(onSelect);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const text = query.trim().toLowerCase();

  const results = useMemo((): Result[] => {
    if (!text) return [];
    const pages = Object.values(PAGES)
      .filter((p) => !PENDING.includes(p.id))
      .filter((p) => p.label.toLowerCase().includes(text) || p.description.toLowerCase().includes(text))
      .map((p): Result => ({ kind: "page", page: p.id }));
    const settings = settingsIndex()
      .filter((e) => e.label.toLowerCase().includes(text) || e.keywords?.toLowerCase().includes(text))
      .sort((a, b) => Number(!a.label.toLowerCase().startsWith(text)) - Number(!b.label.toLowerCase().startsWith(text)))
      .slice(0, 12)
      .map((entry): Result => ({ kind: "setting", entry }));
    return [...pages, ...settings];
  }, [text]);

  const go = (result: Result) => {
    if (result.kind === "page") {
      requestJump(null);
      onSelect(result.page);
    } else {
      requestJump(result.entry.id);
      onSelect(result.entry.page);
    }
    setQuery("");
    input.current?.blur();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-[11px] pt-2.5">
        <NavRow label="Back" icon={<ArrowLeftIcon className="size-4 text-icon" />} onClick={onClose} />
      </div>
      <div className="shrink-0 px-[11px] pt-2.5 pb-3">
        <label className="flex h-8 items-center gap-2 rounded-lg bg-fill px-2.5 transition-shadow focus-within:shadow-[0_0_0_1.5px_color-mix(in_oklab,var(--color-focus)_45%,transparent)]">
          <SearchIcon className="size-3.5 shrink-0 text-icon" />
          <input
            ref={input}
            value={query}
            spellCheck={false}
            placeholder="Search settings"
            aria-label="Search settings"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (query) e.stopPropagation();
                setQuery("");
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && results[active]) go(results[active]);
            }}
            className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="grid size-4 place-items-center rounded-full bg-text-muted/25 text-text hover:bg-text-muted/40"
            >
              <XIcon className="size-2.5" strokeWidth={3} />
            </button>
          )}
        </label>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-[11px] pb-3">
        {text ? (
          <Results results={results} active={active} query={text} onHover={setActive} onPick={go} raw={query} />
        ) : (
          <Groups section={section} onSelect={onSelect} />
        )}
      </nav>
      <UpdatePill onOpen={() => onSelect("about")} />
    </div>
  );
}

/** A release waiting to be taken, at the foot of the nav: what it is doing, and the one thing to do next. */
function UpdatePill({ onOpen }: { onOpen: () => void }) {
  const state = useUpdateState();
  const { download, restart, cancel } = useUpdateActions();
  let label: string;
  let glyph = <ArrowDownToLineIcon className="size-4 shrink-0 text-accent" />;
  let action: { label: string; run: () => void } | null = null;
  switch (state.phase) {
    case "available":
      label = `Crew ${state.offer.version} available`;
      action = { label: "Download", run: download };
      break;
    case "downloading": {
      const percent = state.total ? Math.round((state.received / state.total) * 100) : null;
      label = percent === null ? `Downloading ${state.offer.version}` : `Downloading ${state.offer.version} · ${percent}%`;
      action = { label: "Cancel", run: cancel };
      break;
    }
    case "staging":
      label = `Preparing ${state.offer.version}`;
      break;
    case "ready":
      label = `Crew ${state.offer.version} is ready`;
      glyph = <RotateCwIcon className="size-4 shrink-0 text-accent" />;
      action = { label: "Restart", run: restart };
      break;
    default:
      return null;
  }
  return (
    <div className="shrink-0 px-[11px] pb-3">
      <div className="flex h-9 items-center gap-2 rounded-chrome bg-accent/12 pr-1 pl-2">
        <button
          type="button"
          data-tauri-drag-region="false"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
        >
          {glyph}
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{label}</span>
        </button>
        {action && (
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={action.run}
            className="h-7 shrink-0 rounded-md px-2 text-[12px] font-medium text-accent outline-none hover:bg-accent/12 focus-visible:ring-2 focus-visible:ring-focus/50"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

function Groups({ section, onSelect }: { section: SettingsSectionId; onSelect: (id: SettingsSectionId) => void }) {
  const attention = useProviderAttention();
  return (
    <div className="flex flex-col gap-4">
      {NAV_GROUPS.map((group, gi) => (
        <div key={gi} className="flex flex-col gap-0.5">
          {group.title && <p className="px-2 pb-1 text-[11px] font-medium text-text-muted">{group.title}</p>}
          {group.pages.map((id) => {
            const page = PAGES[id];
            const Glyph = page.icon;
            const on = id === section;
            return (
              <NavRow
                key={id}
                label={page.label}
                active={on}
                icon={<Glyph className={`size-4 ${on ? "text-text" : "text-icon"}`} />}
                end={id === "providers" && attention.count > 0 ? <AttentionBadge attention={attention} /> : undefined}
                onClick={() => {
                  requestJump(null);
                  onSelect(id);
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Updates waiting and signed-out CLIs, on the Providers row. */
function AttentionBadge({ attention }: { attention: { count: number; signedOut: boolean } }) {
  return (
    <span
      title={attention.signedOut ? "Updates available or signed out" : "Updates available"}
      className={`grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold tabular-nums ${
        attention.signedOut ? "bg-warning/20 text-warning" : "bg-info/15 text-info"
      }`}
    >
      {attention.count}
    </span>
  );
}

function NavRow({
  label,
  icon,
  end,
  active = false,
  onClick,
}: {
  label: ReactNode;
  icon: ReactNode;
  end?: ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left outline-none transition-colors duration-150 ${
        active ? "bg-selected font-medium" : "hover:bg-hover focus-visible:bg-hover"
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {end}
    </button>
  );
}

function Results({
  results,
  active,
  query,
  raw,
  onHover,
  onPick,
}: {
  results: Result[];
  active: number;
  query: string;
  raw: string;
  onHover: (i: number) => void;
  onPick: (r: Result) => void;
}) {
  if (results.length === 0)
    return (
      <div className="flex flex-col gap-1 px-2 pt-6 text-center">
        <p>No settings match “{raw.trim()}”</p>
        <p className="text-[12px] text-text-muted">Try “theme” or “shortcut”.</p>
      </div>
    );
  const firstSetting = results.findIndex((r) => r.kind === "setting");
  return (
    <div role="listbox" aria-label="Search results" className="flex flex-col gap-0.5">
      {results.map((r, i) => {
        const page = PAGES[r.kind === "page" ? r.page : r.entry.page];
        const Glyph = page.icon;
        const label = r.kind === "page" ? page.label : r.entry.label;
        return (
          <div key={r.kind === "page" ? `p:${r.page}` : `s:${r.entry.id}`}>
            {i === 0 && r.kind === "page" && <p className="px-2 pb-1 text-[11px] font-medium text-text-muted">Pages</p>}
            {i === firstSetting && (
              <p className={`px-2 pb-1 text-[11px] font-medium text-text-muted ${i > 0 ? "pt-3" : ""}`}>Settings</p>
            )}
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseMove={() => onHover(i)}
              onClick={() => onPick(r)}
              className={`flex min-h-8 w-full items-center gap-2.5 rounded-chrome px-2 py-1 text-left outline-none ${
                i === active ? "bg-hover" : ""
              }`}
            >
              <Glyph className="size-4 shrink-0 text-icon" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">
                  <Match text={label} query={query} />
                </span>
                {r.kind === "setting" && <span className="truncate text-[11px] text-text-muted">{page.label}</span>}
              </span>
              {i === active && <CornerDownLeftIcon className="size-3.5 shrink-0 text-text-muted" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The matched run marked the way ⌘F marks a match. */
function Match({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-find text-text">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}
