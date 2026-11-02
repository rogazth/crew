/**
 * Everyone this chat has worked with, in the right panel: its Crew sub-agents,
 * the sessions it started, the CLI's own sub-agents and its conversations. A
 * list the way the sidebar lists its sessions: find, a view menu, sections that
 * fold. Nothing here can be cleared, so what ended stays findable.
 */
import { Menu } from "@base-ui/react/menu";
import {
  ALargeSmallIcon,
  ArrowUpDownIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ClockIcon,
  CpuIcon,
  LayoutListIcon,
  ListFilterIcon,
  ListOrderedIcon,
  RowsIcon,
  SearchIcon,
  XIcon,
  type LucideIcon as Icon,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { PANEL, ROW } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { StatusDot } from "../../chrome/StatusDot";
import { modelLine, tokensLabel, tokensTitle, type ConversationEntry, type PanelEntry } from "../../lib/backgroundPanel";
import { PROVIDERS } from "../../lib/providers";
import type { ThreadRef } from "../../lib/letters";
import { elapsed } from "../../lib/time";
import type { Session } from "../../lib/types";
import { Face } from "./Letters";
import { QuietStop } from "./Panel";

type Bucket = "needs" | "working" | "done";
const BUCKETS: { id: Bucket; label: string }[] = [
  { id: "needs", label: "Needs an answer" },
  { id: "working", label: "Working" },
  { id: "done", label: "Finished" },
];
const bucketOf = (entry: PanelEntry): Bucket => (entry.attention ? "needs" : entry.state === "running" ? "working" : "done");

type Grouping = "status" | "none";
type Ordering = "recent" | "started" | "name";
type Recency = "any" | "day" | "3days" | "week";
type ListPrefs = { groupBy: Grouping; ordering: Ordering; recency: Recency; hiddenBuckets: Bucket[]; hiddenProviders: string[] };
const DEFAULTS: ListPrefs = { groupBy: "status", ordering: "recent", recency: "any", hiddenBuckets: [], hiddenProviders: [] };

const GROUPINGS: { id: Grouping; label: string; icon: Icon }[] = [
  { id: "status", label: "Status", icon: CircleDashedIcon },
  { id: "none", label: "None", icon: RowsIcon },
];
const ORDERINGS: { id: Ordering; label: string; icon: Icon }[] = [
  { id: "recent", label: "Last activity", icon: ClockIcon },
  { id: "started", label: "Started", icon: ListOrderedIcon },
  { id: "name", label: "Name", icon: ALargeSmallIcon },
];
const RECENCIES: { id: Recency; label: string; ms: number | null }[] = [
  { id: "any", label: "Any time", ms: null },
  { id: "day", label: "Last 24 hours", ms: 864e5 },
  { id: "3days", label: "Last 3 days", ms: 3 * 864e5 },
  { id: "week", label: "Last week", ms: 7 * 864e5 },
];

const STORE = "crew:agent-list";
function readPrefs(): ListPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORE) ?? "{}") as Partial<ListPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

const toggled = <T,>(list: readonly T[], item: T): T[] => (list.includes(item) ? list.filter((one) => one !== item) : [...list, item]);

/** When it last did something: when it ended, else its row's last change. */
function lastOf(entry: PanelEntry, sessions: readonly Session[]): number {
  if (entry.endedAt !== undefined) return entry.endedAt;
  const session = entry.source.type === "session" ? sessions.find((row) => row.id === entry.source.id) : undefined;
  return session?.updatedAt ?? entry.startedAt;
}

export function AgentList({
  entries,
  conversations,
  sessions,
  failed,
  onOpen,
  onOpenConversation,
  onStop,
  onClose,
}: {
  entries: readonly PanelEntry[];
  conversations: readonly ConversationEntry[];
  sessions: readonly Session[];
  failed: Readonly<Record<string, string>>;
  onOpen: (entry: PanelEntry) => void;
  onOpenConversation: (thread: ThreadRef) => void;
  onStop: (entry: PanelEntry) => void;
  onClose: () => void;
}) {
  const [prefs, setStored] = useState<ListPrefs>(readPrefs);
  const setPrefs = useCallback((next: ListPrefs) => {
    setStored(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      // A window that cannot store it keeps it for now.
    }
  }, []);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [folds, setFolds] = useState<Partial<Record<string, boolean>>>({});
  const [now] = useState(() => Date.now());
  const q = query.trim().toLowerCase();
  const recency = RECENCIES.find((one) => one.id === prefs.recency)!;
  const shown = entries
    .filter(
      (entry) =>
        !prefs.hiddenBuckets.includes(bucketOf(entry)) &&
        !prefs.hiddenProviders.includes(entry.provider ?? "") &&
        (recency.ms === null || now - lastOf(entry, sessions) < recency.ms) &&
        (!q || entry.title.toLowerCase().includes(q)),
    )
    .sort((a, b) =>
      prefs.ordering === "name" ? a.title.localeCompare(b.title) : prefs.ordering === "started" ? b.startedAt - a.startedAt : lastOf(b, sessions) - lastOf(a, sessions),
    );
  const talks = conversations.filter((one) => !q || one.label.toLowerCase().includes(q));
  const sections =
    prefs.groupBy === "status"
      ? BUCKETS.map((bucket) => ({ key: bucket.id as string, head: bucket.label as string | null, rows: shown.filter((entry) => bucketOf(entry) === bucket.id) }))
      : [{ key: "all", head: null as string | null, rows: shown }];
  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery("");
  }, []);
  const filtered = prefs.hiddenBuckets.length + prefs.hiddenProviders.length > 0 || prefs.recency !== "any";
  const total = entries.length + conversations.length;
  const listed = shown.length + talks.length;
  const head = (key: string, label: string, count: number, open: boolean) => (
    <button type="button" onClick={() => setFolds({ ...folds, [key]: !open })} className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] text-text-muted hover:text-text">
      <ChevronRightIcon className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="tabular-nums">{count}</span>
    </button>
  );
  return (
    <div data-agent-list className="flex min-h-0 flex-1 flex-col text-[13px]">
      <div className="shrink-0 px-3 pt-2.5 pb-1">
        {searching ? (
          <div className="flex h-8 items-center gap-2 rounded-chrome bg-card pr-1 pl-2">
            <SearchIcon className="size-3.5 shrink-0 text-icon" />
            <input
              autoFocus
              value={query}
              placeholder="Find sub-agents"
              aria-label="Find sub-agents"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onBlur={() => !query.trim() && closeSearch()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeSearch();
                }
              }}
              className="h-full min-w-0 flex-1 bg-transparent py-0 outline-none"
            />
            <button type="button" aria-label="Close search" onMouseDown={(event) => event.preventDefault()} onClick={closeSearch} className="grid size-6 shrink-0 place-items-center rounded-md text-icon hover:bg-hover hover:text-text">
              <XIcon className="size-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex h-8 items-center gap-0.5 pl-1.5">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">Sub-agents</span>
            <span className="pr-1.5 text-[12px] text-text-muted tabular-nums">{listed === total ? total : `${listed} of ${total}`}</span>
            <button type="button" aria-label="Find" title="Find" onClick={() => setSearching(true)} className="grid size-6 shrink-0 place-items-center rounded-md text-icon transition-colors hover:bg-hover hover:text-text">
              <SearchIcon className="size-4" />
            </button>
            <ViewMenu prefs={prefs} onPrefs={setPrefs} providers={[...new Set(entries.flatMap((entry) => (entry.provider ? [entry.provider] : [])))]} />
            <button type="button" onClick={onClose} aria-label="Close" title="Close" className="grid size-6 shrink-0 place-items-center rounded-md text-icon transition-colors hover:bg-hover hover:text-text">
              <XIcon className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      <div data-selectable="blocks" className="crew-scroll-shadow min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {listed === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center">
            <span className="text-placeholder">{total === 0 ? "No sub-agents yet" : q ? "Nothing matches" : "Nothing left after the filters"}</span>
            {total > 0 && (filtered || q) ? (
              <button
                type="button"
                onClick={() => {
                  closeSearch();
                  setPrefs({ ...prefs, hiddenBuckets: [], hiddenProviders: [], recency: "any" });
                }}
                className="rounded-md px-2 py-1 text-[12px] text-text-muted hover:bg-hover hover:text-text"
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}
        {sections
          .filter((section) => section.rows.length > 0)
          .map((section) => {
            const open = folds[section.key] ?? true;
            return (
              <div key={section.key} data-list-section={section.key} className="pb-1">
                {section.head ? head(section.key, section.head, section.rows.length, open) : null}
                {open ? (
                  <div className="flex flex-col">
                    {section.rows.map((entry) => (
                      <AgentItem key={entry.id} entry={entry} last={lastOf(entry, sessions)} error={failed[entry.id]} onOpen={onOpen} onStop={onStop} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        {talks.length > 0 ? (
          <div data-list-section="conversations" className="pb-1">
            {head("conversations", "Conversations", talks.length, folds.conversations ?? true)}
            {(folds.conversations ?? true) ? (
              <div className="flex flex-col">
                {talks.map((talk) => (
                  <button key={talk.key} type="button" data-conversation={talk.key} onClick={() => onOpenConversation(talk.thread)} className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none hover:bg-hover focus-visible:bg-hover">
                    <Face party={talk.party} sessions={sessions} className="size-4" />
                    <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium">{talk.label}</span>
                    <span className="shrink-0 text-[12px] text-text-muted tabular-nums">{elapsed(talk.at)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Its name and when, then what runs it. A dot only for what is alive, as a session's row. */
function AgentItem({ entry, last, error, onOpen, onStop }: { entry: PanelEntry; last: number; error: string | undefined; onOpen: (entry: PanelEntry) => void; onStop: (entry: PanelEntry) => void }) {
  const model = modelLine(entry);
  const tokens = tokensLabel(entry);
  const asks = entry.attention === "approval" ? "Needs approval" : entry.attention ? "Waiting for an answer" : null;
  const ended = entry.state === "failed" ? "Failed" : entry.state === "stopped" ? "Stopped" : null;
  return (
    <div
      role="button"
      tabIndex={0}
      data-entry={entry.id}
      data-attention={entry.attention}
      title={entry.detail || entry.title}
      onClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(entry);
      }}
      className="group flex w-full cursor-default flex-col gap-0.5 rounded-xl px-2.5 py-2 text-left outline-none hover:bg-hover focus-visible:bg-hover"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium">{entry.title}</span>
        {entry.state === "running" && entry.stoppable ? <QuietStop entry={entry} onStop={() => onStop(entry)} /> : null}
        <span className="shrink-0 text-[12px] text-text-muted tabular-nums">{elapsed(last)}</span>
        {entry.attention ? <StatusDot status="needs-input" /> : entry.state === "running" ? <StatusDot status="working" /> : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-text-muted">
        {entry.provider ? <ProviderIcon provider={entry.provider} className="size-3 shrink-0" /> : null}
        <span className="truncate">
          {asks ? <span className="text-warning">{asks} · </span> : null}
          {ended ? <span className={entry.state === "failed" ? "text-danger" : ""}>{ended} · </span> : null}
          {model ?? (entry.kind === "session" ? "Session" : "Sub-agent")}
          {tokens ? <span title={tokensTitle(entry)}> · {tokens}</span> : null}
          {entry.state === "running" && entry.activity ? <span className="text-placeholder"> · {entry.activity}</span> : null}
          {error ? <span title={error} className="text-danger"> · {error}</span> : null}
        </span>
      </span>
    </div>
  );
}

function ViewMenu({ prefs: p, onPrefs, providers }: { prefs: ListPrefs; onPrefs: (next: ListPrefs) => void; providers: string[] }) {
  const dirty = p.groupBy !== DEFAULTS.groupBy || p.ordering !== DEFAULTS.ordering || p.recency !== "any" || p.hiddenBuckets.length + p.hiddenProviders.length > 0;
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        data-list-view
        aria-label="Customize the list"
        title="Customize the list"
        className={`relative grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors hover:bg-hover hover:text-text data-popup-open:bg-hover data-popup-open:text-text ${dirty ? "text-text" : "text-icon"}`}
      >
        <ListFilterIcon className="size-4" />
        {dirty ? <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-text ring-2 ring-canvas" /> : null}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            <Submenu icon={LayoutListIcon} label="Group by" value={GROUPINGS.find((one) => one.id === p.groupBy)?.label}>
              <Menu.RadioGroup value={p.groupBy} onValueChange={(value) => onPrefs({ ...p, groupBy: value as Grouping })}>
                {GROUPINGS.map((item) => (
                  <Radio key={item.id} value={item.id} label={item.label} icon={item.icon} />
                ))}
              </Menu.RadioGroup>
            </Submenu>
            <Submenu icon={ArrowUpDownIcon} label="Ordering" value={ORDERINGS.find((one) => one.id === p.ordering)?.label}>
              <Menu.RadioGroup value={p.ordering} onValueChange={(value) => onPrefs({ ...p, ordering: value as Ordering })}>
                {ORDERINGS.map((item) => (
                  <Radio key={item.id} value={item.id} label={item.label} icon={item.icon} />
                ))}
              </Menu.RadioGroup>
            </Submenu>
            <Menu.Separator className="mx-2 my-1 h-px bg-border" />
            <Submenu icon={CircleDashedIcon} label="Status" active={p.hiddenBuckets.length > 0}>
              {BUCKETS.map((bucket) => (
                <Check key={bucket.id} label={bucket.label} checked={!p.hiddenBuckets.includes(bucket.id)} onChange={() => onPrefs({ ...p, hiddenBuckets: toggled(p.hiddenBuckets, bucket.id) })} />
              ))}
            </Submenu>
            <Submenu icon={CpuIcon} label="Provider" active={p.hiddenProviders.length > 0}>
              {providers.map((id) => (
                <Check
                  key={id}
                  label={PROVIDERS.find((one) => one.id === id)?.label ?? id}
                  icon={<ProviderIcon provider={id} className="size-4 shrink-0" />}
                  checked={!p.hiddenProviders.includes(id)}
                  onChange={() => onPrefs({ ...p, hiddenProviders: toggled(p.hiddenProviders, id) })}
                />
              ))}
            </Submenu>
            <Submenu icon={ClockIcon} label="Last activity" value={p.recency === "any" ? undefined : RECENCIES.find((one) => one.id === p.recency)?.label} active={p.recency !== "any"}>
              <Menu.RadioGroup value={p.recency} onValueChange={(value) => onPrefs({ ...p, recency: value as Recency })}>
                {RECENCIES.map((item) => (
                  <Radio key={item.id} value={item.id} label={item.label} />
                ))}
              </Menu.RadioGroup>
            </Submenu>
            {dirty ? (
              <>
                <Menu.Separator className="mx-2 my-1 h-px bg-border" />
                <Menu.Item onClick={() => onPrefs(DEFAULTS)} className={ROW}>
                  <span className="min-w-0 flex-1 truncate">Reset view</span>
                </Menu.Item>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Submenu({ icon: Glyph, label, value, active = false, children }: { icon: Icon; label: string; value?: string | undefined; active?: boolean; children: ReactNode }) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={ROW}>
        <Glyph className="size-4 shrink-0 text-icon" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {value ? <span className="shrink-0 text-text-muted">{value}</span> : null}
        {active ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current text-text-muted" /> : null}
        <ChevronRightIcon className="size-3.5 shrink-0 text-icon" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner className="z-50" side="left" sideOffset={4} alignOffset={-4} collisionAvoidance={{ side: "flip", align: "shift" }}>
          <Menu.Popup className={PANEL}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

function Radio({ value, label, icon: Glyph }: { value: string; label: string; icon?: Icon }) {
  return (
    <Menu.RadioItem value={value} className={ROW}>
      {Glyph ? <Glyph className="size-4 shrink-0 text-icon" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Menu.RadioItemIndicator>
        <CheckIcon className="size-4 shrink-0" />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}

function Check({ label, icon, checked, onChange }: { label: string; icon?: ReactNode; checked: boolean; onChange: () => void }) {
  return (
    <Menu.CheckboxItem checked={checked} onCheckedChange={onChange} closeOnClick={false} className={ROW}>
      {icon}
      <span className="min-w-0 max-w-64 flex-1 truncate">{label}</span>
      <Menu.CheckboxItemIndicator>
        <CheckIcon className="size-4 shrink-0" />
      </Menu.CheckboxItemIndicator>
    </Menu.CheckboxItem>
  );
}
