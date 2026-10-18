// PROTOTYPE — throwaway. The routine editor's "who runs this" control with a
// direction on: one picker for a bot *in* a workspace, instead of a Workspace
// select beside a Bot select. It loads the bots of every workspace up front, so
// picking one sets both at once and the pair can never disagree.
//
// Trigger: the chosen bot's face, its name, and under it the workspace's mark +
// name and the bot's provider. Popup: a search field, then bots grouped by
// workspace. ↑/↓ move, Enter picks, Esc clears the search and then closes.
import { Popover } from "@base-ui/react/popover";
import { BotIcon, CheckIcon, ChevronsUpDownIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { BotAvatar } from "../../../chrome/BotAvatar";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import * as api from "../../../lib/api";
import { fuzzyMatch } from "../../../lib/fuzzy";
import { providerLine } from "../../../lib/providers";
import type { Session, Workspace } from "../../../lib/types";
import { filterSessions, workspaceMark } from "../../../lib/workspaces";

type Props = {
  workspaces: Workspace[];
  workspaceId: string;
  sessionId: string;
  onChange: (workspaceId: string, sessionId: string) => void;
};

/** Each workspace's bots, or "error" when its list could not be read. */
type Loaded = Record<string, Session[] | "error">;
type Row = { workspace: Workspace; bot: Session };
type KeyDown = KeyboardEvent<HTMLDivElement> & { preventBaseUIHandler?: () => void };

export function BotPicker({ workspaces, workspaceId, sessionId, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** Bumped on every open, so a bot made since the editor opened shows up. */
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const key = workspaces.map((workspace) => workspace.id).join("\n");
  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split("\n") : [];
    void Promise.allSettled(ids.map((id) => api.listSessions(id))).then((results) => {
      if (cancelled) return;
      const next: Loaded = {};
      results.forEach((result, index) => {
        const id = ids[index];
        if (id === undefined) return;
        next[id] = result.status === "fulfilled" ? result.value.filter((session) => session.kind === "bot") : "error";
      });
      setLoaded(next);
    });
    return () => {
      cancelled = true;
    };
  }, [key, refresh]);

  const needle = query.trim();
  const searching = needle.length > 0;
  const groups = workspaces.flatMap((workspace) => {
    const entry = loaded?.[workspace.id];
    const bots = Array.isArray(entry) ? entry : [];
    // A workspace's name finds all of its bots; otherwise the bot's name, then its provider.
    const shown = !searching || fuzzyMatch(needle, workspace.name) ? bots : filterSessions(bots, needle);
    if (searching && shown.length === 0) return [];
    return [{ workspace, bots: shown, failed: entry === "error" }];
  });
  const rows: Row[] = groups.flatMap((group) => group.bots.map((bot) => ({ workspace: group.workspace, bot })));
  /** Where each group's first row sits in `rows`, for the keyboard cursor. */
  const starts = groups.map((_, at) => groups.slice(0, at).reduce((sum, group) => sum + group.bots.length, 0));
  const active = rows.length === 0 ? -1 : Math.min(cursor, rows.length - 1);

  const chosenWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const entry = loaded?.[workspaceId];
  const chosen = Array.isArray(entry) ? (entry.find((bot) => bot.id === sessionId) ?? null) : null;

  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, needle]);

  function currentIndex(): number {
    const all = workspaces.flatMap((workspace) => {
      const bots = loaded?.[workspace.id];
      return Array.isArray(bots) ? bots.map((bot) => ({ workspace, bot })) : [];
    });
    const index = all.findIndex((row) => row.workspace.id === workspaceId && row.bot.id === sessionId);
    return index < 0 ? 0 : index;
  }

  function openChange(next: boolean) {
    if (next) {
      setQuery("");
      setCursor(currentIndex());
      setRefresh((n) => n + 1);
    }
    setOpen(next);
  }

  function pick(row: Row) {
    onChange(row.workspace.id, row.bot.id);
    setOpen(false);
  }

  function clear() {
    setQuery("");
    setCursor(currentIndex());
  }

  function onKeyDown(event: KeyDown) {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      event.preventBaseUIHandler?.();
      clear();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const from = active < 0 ? 0 : active;
      setCursor(Math.max(0, Math.min(rows.length - 1, from + step)));
      return;
    }
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={openChange} modal={false}>
      <Popover.Trigger className="flex h-14 w-full items-center gap-3 rounded-xl bg-card px-3 text-left outline-none transition-[background-color,box-shadow] duration-150 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50 data-popup-open:bg-hover motion-reduce:transition-none">
        {chosen && chosenWorkspace ? (
          <>
            <BotAvatar seed={chosen.id} bare className="size-9" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{chosen.name}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-muted">
                <WorkspaceMark name={chosenWorkspace.name} />
                <span className="min-w-0 truncate">{chosenWorkspace.name}</span>
                <span aria-hidden className="text-placeholder">
                  ·
                </span>
                <ProviderIcon provider={chosen.provider} className="size-3" />
                <span className="min-w-0 truncate">{providerLine(chosen.provider, chosen.model)}</span>
              </span>
            </span>
          </>
        ) : (
          <>
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-fill text-text-muted">
              <BotIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate text-text-muted">
              {loaded === null && sessionId ? "Loading…" : "Choose a bot"}
            </span>
          </>
        )}
        <ChevronsUpDownIcon className="size-4 shrink-0 text-icon" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Popover.Popup
            initialFocus={search}
            onKeyDown={onKeyDown}
            className="flex max-h-[min(420px,var(--available-height))] w-(--anchor-width) min-w-72 origin-(--transform-origin) flex-col overflow-hidden rounded-float bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 motion-reduce:transition-none"
          >
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3">
              <SearchIcon className="size-3.5 shrink-0 text-icon" />
              <input
                ref={search}
                value={query}
                placeholder="Search bots or workspaces"
                aria-label="Search bots"
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                spellCheck={false}
                onChange={(event) => {
                  const next = event.target.value;
                  setQuery(next);
                  if (next.trim()) setCursor(0);
                  else setCursor(currentIndex());
                }}
                className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    clear();
                    search.current?.focus();
                  }}
                  className="grid size-5 shrink-0 place-items-center rounded-md text-icon outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </div>

            <div ref={list} id={listId} role="listbox" aria-label="Bots" className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {loaded === null ? (
                <p className="px-2 py-8 text-center text-placeholder">Loading bots…</p>
              ) : groups.length === 0 ? (
                <p className="px-2 py-8 text-center text-placeholder">{searching ? "No matches" : "No workspaces"}</p>
              ) : (
                groups.map((group, groupAt) => (
                  <div key={group.workspace.id} role="group" aria-label={group.workspace.name} className="pb-1 last:pb-0">
                    <div aria-hidden className="flex h-7 items-center gap-2 px-2 text-[11px] text-text-muted">
                      <WorkspaceMark name={group.workspace.name} />
                      <span className="min-w-0 flex-1 truncate font-medium">{group.workspace.name}</span>
                    </div>
                    {group.bots.length === 0 ? (
                      <p className="flex h-8 items-center px-2 pl-8 text-[12px] text-placeholder">
                        {group.failed ? "Couldn't load bots" : "No bots"}
                      </p>
                    ) : (
                      group.bots.map((bot, botAt) => {
                        const at = (starts[groupAt] ?? 0) + botAt;
                        const row = { workspace: group.workspace, bot };
                        const current = group.workspace.id === workspaceId && bot.id === sessionId;
                        return (
                          <div
                            key={bot.id}
                            id={`${listId}-${at}`}
                            role="option"
                            aria-selected={current}
                            data-index={at}
                            onMouseMove={() => setCursor(at)}
                            onClick={() => pick(row)}
                            className={`flex h-9 w-full cursor-default items-center gap-2.5 rounded-lg px-2 text-left select-none ${
                              at === active ? "bg-hover" : current ? "bg-selected" : ""
                            }`}
                          >
                            <BotAvatar seed={bot.id} bare className="size-6" />
                            <span className={`min-w-0 flex-1 truncate ${current ? "font-medium" : ""}`}>{bot.name}</span>
                            <ProviderIcon provider={bot.provider} className="size-3.5" />
                            <span className="grid size-4 shrink-0 place-items-center">
                              {current && <CheckIcon className="size-4 text-accent" />}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                ))
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The rail's workspace tile, shrunk to sit beside a line of text. */
function WorkspaceMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded-[5px] bg-accent text-[7.5px] leading-none font-semibold tracking-wide text-inverse"
    >
      {workspaceMark(name)}
    </span>
  );
}
