import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Popover } from "@base-ui/react/popover";
import { CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import { ProviderIcon } from "./ProviderIcon";
import { useInstalledProviders } from "../hooks/useInstalledProviders";
import { useListedModels } from "../hooks/useListedModels";
import { pickerKeyDown } from "./promptKeys";
import {
  PROVIDERS,
  modelLabel,
  modelsOf,
  providerOf,
  searchModels,
  type Model,
  type ModelMatch,
  type ProviderId,
} from "../lib/providers";

/** Lets the composer open a chip's menu, as the `/` menu's actions do. */
export type Opener = { open: () => void };

/** A whole row as the trigger, in a card of rows: its icon, its label, and the value with a chevron at the right end. */
export const ROW_TRIGGER =
  "group flex min-h-12 w-full items-center gap-3 py-2.5 text-left text-[13px] outline-none focus-visible:[&_[data-row-value]]:text-text data-popup-open:[&_[data-row-value]]:text-text";

/** What a row trigger shows: the row's own icon and label; the picker fills in the value. */
export type RowLabel = { icon: ReactNode; label: string };

type Props = {
  ref?: Ref<Opener>;
  provider: string;
  model: string;
  /** "field" is the sheet's full-width control; "chip" is the composer's compact trigger. */
  trigger?: "field" | "chip";
  /** The whole row is the trigger instead, labelled as given (ROW_TRIGGER). */
  row?: RowLabel;
  disabled?: boolean;
  /** A running session keeps its CLI: only its own provider's models are offered. */
  lockProvider?: boolean;
  onChange: (provider: ProviderId, model: string) => void;
};

type KeyDown = KeyboardEvent<HTMLDivElement> & { preventBaseUIHandler?: () => void };

/** Providers beside their models: hover a provider, click a model. A query searches every provider at once. */
export function ModelPicker({ ref, provider, model, trigger = "field", row, disabled = false, lockProvider = false, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ProviderId>(provider as ProviderId);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  /** Keyboard highlight. Off while browsing, so the open list still looks like a hover menu. */
  const [armed, setArmed] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const chip = trigger === "chip";
  // A row's picker sits in a narrow pane: the providers go in a strip over the models, not a column beside them.
  const compact = row !== undefined;
  const installed = useInstalledProviders(open);
  useListedModels(provider);
  // The session's own provider stays reachable even after its CLI is gone.
  const tabs = PROVIDERS.filter((p) => p.id === provider || (!lockProvider && installed.includes(p)));
  const needle = query.trim();
  const searching = needle.length > 0;
  const rows: ModelMatch[] = searching
    ? searchModels(tabs, needle)
    : modelsOf(tab).map((item) => ({ provider: tab, model: item }));
  const active = rows.length === 0 ? -1 : Math.min(cursor, rows.length - 1);
  const marked = searching || armed;

  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, needle, tab]);

  function openChange(next: boolean) {
    if (next) {
      setTab(provider as ProviderId);
      setQuery("");
      setCursor(modelIndex(provider, model));
      setArmed(false);
    }
    setOpen(next);
  }

  useImperativeHandle(ref, () => ({ open: () => openChange(true) }));

  function pick(row: ModelMatch) {
    onChange(row.provider, row.model.id);
    setOpen(false);
  }

  function showTab(id: ProviderId) {
    setTab(id);
    setCursor(id === provider ? modelIndex(id, model) : 0);
  }

  function onKeyDown(event: KeyDown) {
    if (pickerKeyDown(event, "P", () => setOpen(false))) return;
    // Typing anywhere in it searches: focus on a provider or a model hands the keys to the search, which takes this one too.
    if (event.target !== search.current && typed(event)) {
      search.current?.focus();
      return;
    }
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      event.preventBaseUIHandler?.();
      setQuery("");
      setArmed(false);
      setCursor(tab === provider ? modelIndex(tab, model) : 0);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setArmed(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const from = active < 0 ? 0 : active;
      setCursor(Math.max(0, Math.min(rows.length - 1, from + step)));
      return;
    }
    if (!searching && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      setArmed(true);
      const at = tabs.findIndex((item) => item.id === tab);
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(at + step + tabs.length) % tabs.length];
      if (next && next.id !== tab) showTab(next.id);
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
      {row ? (
        <Popover.Trigger
          disabled={disabled}
          className={ROW_TRIGGER}
          // Typing on the row opens it searching for what was typed.
          onKeyDown={(event) => {
            if (open || !typed(event) || event.key.length !== 1) return;
            event.preventDefault();
            openChange(true);
            setQuery(event.key);
            setCursor(0);
          }}
        >
          <span className="grid size-5 shrink-0 place-items-center text-icon">{row.icon}</span>
          <span className="min-w-0 flex-1 font-medium">{row.label}</span>
          <span data-row-value className="flex min-w-0 items-center gap-1.5 text-text-muted transition-colors group-hover:text-text">
            <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
            <span className="truncate">{modelLabel(provider, model)}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-icon" />
          </span>
        </Popover.Trigger>
      ) : chip ? (
        <Popover.Trigger
          disabled={disabled}
          title={`${providerOf(provider)?.label ?? provider} ${modelLabel(provider, model)}`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] leading-4 text-text ring-1 ring-hairline outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-focus/50 disabled:text-text-muted disabled:hover:bg-transparent data-popup-open:bg-hover"
        >
          <ProviderIcon provider={provider} className="size-3.5" />
          <span className="min-w-0 max-w-[140px] truncate">{modelLabel(provider, model)}</span>
        </Popover.Trigger>
      ) : (
        <Popover.Trigger className="flex h-8 w-full items-center gap-2 rounded-lg bg-canvas px-2.5 text-text ring ring-border outline-none transition-[box-shadow] hover:ring-border-strong focus-visible:ring-[1.5px] focus-visible:ring-focus/50 data-popup-open:ring-[1.5px] data-popup-open:ring-focus/50">
          <ProviderIcon provider={provider} className="size-4" />
          <span className="min-w-0 flex-1 truncate text-left">
            {providerOf(provider)?.label} {modelLabel(provider, model)}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-icon" />
        </Popover.Trigger>
      )}

      <Popover.Portal>
        <Popover.Positioner side={chip && !row ? "top" : "bottom"} align={row ? "end" : "start"} sideOffset={4} className="z-50">
          <Popover.Popup
            initialFocus={search}
            onKeyDown={onKeyDown}
            className={`flex ${compact ? "h-[320px] w-[288px]" : "h-[380px] w-[420px]"} origin-(--transform-origin) flex-col overflow-hidden rounded-float bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0`}
          >
            {open && tabs.map((p) => <WarmModels key={p.id} provider={p.id} />)}
            {/* Compact: the providers' faces, the search, the models; nothing else. Picking a provider leaves a search. */}
            {compact && (
              <div role="tablist" aria-label="Provider" className="flex shrink-0 items-center gap-0.5 border-b border-hairline p-1.5">
                {tabs.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={p.id === tab && !searching}
                    aria-label={p.label}
                    title={p.label}
                    onClick={() => {
                      setQuery("");
                      showTab(p.id);
                    }}
                    className={`grid size-8 place-items-center rounded-lg transition-colors ${p.id === tab && !searching ? "bg-selected" : "hover:bg-hover"}`}
                  >
                    <ProviderIcon provider={p.id} className="size-4" />
                  </button>
                ))}
              </div>
            )}
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3">
              <SearchIcon className="size-3.5 shrink-0 text-icon" />
              <input
                ref={search}
                value={query}
                // Opened by a key typed on the row: the caret goes after it, not before.
                onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
                placeholder="Search models"
                aria-label="Search models"
                spellCheck={false}
                onChange={(event) => {
                  const next = event.target.value;
                  setQuery(next);
                  if (next.trim()) {
                    setCursor(0);
                    return;
                  }
                  setArmed(false);
                  setCursor(tab === provider ? modelIndex(tab, model) : 0);
                }}
                className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setQuery("");
                    setArmed(false);
                    setCursor(tab === provider ? modelIndex(tab, model) : 0);
                    search.current?.focus();
                  }}
                  className="grid size-5 shrink-0 place-items-center rounded-md text-icon hover:bg-hover hover:text-text"
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </div>

            {searching ? (
              <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {rows.length === 0 ? (
                  <p className="px-2 py-8 text-center text-placeholder">No matches</p>
                ) : (
                  rows.map((row, index) => (
                    <ModelRow
                      key={`${row.provider}:${row.model.id}`}
                      row={row}
                      index={index}
                      active={marked && index === active}
                      current={isCurrent(provider, model, row)}
                      showProvider={tabs.length > 1}
                      onHover={() => setCursor(index)}
                      onPick={() => pick(row)}
                    />
                  ))
                )}
              </div>
            ) : compact ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div ref={list} role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
                  {rows.map((row, index) => (
                    <ModelRow
                      key={row.model.id}
                      row={row}
                      index={index}
                      active={marked && index === active}
                      current={isCurrent(provider, model, row)}
                      showProvider={false}
                      onHover={() => setCursor(index)}
                      onPick={() => pick(row)}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1">
                {/* Who runs it on the left, what it runs on the right: two lists, not tabs over one. */}
                <div role="tablist" aria-orientation="vertical" className="flex w-[136px] shrink-0 flex-col gap-0.5 border-r border-hairline bg-sidebar/60 p-1.5">
                  <span className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">Provider</span>
                  {tabs.map((p) => {
                    const on = p.id === tab;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => showTab(p.id)}
                        onMouseEnter={() => {
                          if (p.id !== tab) showTab(p.id);
                        }}
                        className={`flex h-8 items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                          on ? "bg-selected text-text" : "text-text/85 hover:bg-hover"
                        }`}
                      >
                        <ProviderIcon provider={p.id} className="size-4" />
                        <span className="min-w-0 flex-1 truncate">{p.label}</span>
                        {p.id === provider && <span className="size-1.5 shrink-0 rounded-full bg-text" aria-label="In use" />}
                      </button>
                    );
                  })}
                </div>

                <div ref={list} role="tabpanel" className="flex min-w-0 flex-1 flex-col overflow-y-auto p-1.5">
                  <span className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">{providerOf(tab)?.label} models</span>
                  {rows.map((row, index) => (
                    <ModelRow
                      key={row.model.id}
                      row={row}
                      index={index}
                      active={marked && index === active}
                      current={isCurrent(provider, model, row)}
                      showProvider={false}
                      onHover={() => setCursor(index)}
                      onPick={() => pick(row)}
                    />
                  ))}
                </div>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ModelRow({
  row,
  index,
  active,
  current,
  showProvider,
  onHover,
  onPick,
}: {
  row: ModelMatch;
  index: number;
  active: boolean;
  current: boolean;
  showProvider: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      data-index={index}
      onMouseMove={onHover}
      onClick={onPick}
      className={`flex min-h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover ${
        active ? "bg-hover" : current ? "bg-card" : ""
      }`}
    >
      {showProvider && <ProviderIcon provider={row.provider} className="size-4 shrink-0" />}
      <span className={`min-w-0 flex-1 truncate ${current ? "font-medium" : ""}`}>{row.model.label}</span>
      {current && <CheckIcon className="size-4 shrink-0 text-icon" />}
    </button>
  );
}

/** A key that writes a character, or takes one away: what a search field would take. A space stays a button's press. */
function typed(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.key === " ") return false;
  return event.key.length === 1 || event.key === "Backspace";
}

/** Asks a provider for the models its CLI lists, so a search can see them before that provider is hovered. */
function WarmModels({ provider }: { provider: string }) {
  useListedModels(provider, true);
  return null;
}

function modelIndex(providerId: string, modelId: string): number {
  const index = modelsOf(providerId).findIndex((item) => sameModel(item, modelId));
  return index < 0 ? 0 : index;
}

function isCurrent(providerId: string, modelId: string, row: ModelMatch): boolean {
  return row.provider === providerId && sameModel(row.model, modelId);
}

function sameModel(item: Model, modelId: string): boolean {
  return (
    item.id === modelId ||
    item.fastId === modelId ||
    Object.values(item.variants ?? {}).includes(modelId) ||
    Object.values(item.fastVariants ?? {}).includes(modelId)
  );
}
