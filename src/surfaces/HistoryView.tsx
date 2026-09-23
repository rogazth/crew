import { Menu } from "@base-ui/react/menu";
import { Button, Input } from "@cloudflare/kumo";
import { ClockCounterClockwiseIcon, GlobeIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import * as api from "../lib/api";
import { CLEAR_RANGES, clearSince, groupByDay, hostOf, type ClearRange } from "../lib/browser/history";
import type { HistoryEntry } from "../lib/protocol";
import { clock } from "../lib/time";

type Props = {
  /** Loads the page in the browser tab underneath, or a new one if there is none. */
  onOpen: (url: string) => void;
  onConfirm: (confirm: Confirm) => void;
};

/** Rows per request. One more is asked for, to know whether there is another page. */
const PAGE = 200;
const DEBOUNCE_MS = 120;

const PANEL =
  "w-44 origin-(--transform-origin) rounded-xl bg-kumo-control p-1 text-kumo-default shadow-lg ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";
const ITEM =
  "flex h-8 w-full cursor-default items-center rounded-md px-2 text-left outline-none select-none data-highlighted:bg-hover";

/** Every page the browser has shown, newest first, searchable and forgettable. */
export function HistoryView({ onOpen, onConfirm }: Props) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<HistoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  // Bumped to read the list again after a clear.
  const [reload, setReload] = useState(0);
  // Answers can land out of order; only the newest request may paint.
  const latest = useRef(0);
  const text = query.trim();

  useEffect(() => {
    const ticket = ++latest.current;
    const timer = window.setTimeout(() => {
      void api
        .browserHistoryList({ ...(text ? { text } : {}), limit: PAGE + 1 })
        .then((found) => {
          if (latest.current !== ticket) return;
          setRows(found.slice(0, PAGE));
          setMore(found.length > PAGE);
        })
        .catch(() => {
          if (latest.current === ticket) setRows([]);
        });
    }, text ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [text, reload]);

  function loadMore() {
    const last = rows?.at(-1);
    if (!last) return;
    const ticket = ++latest.current;
    void api
      .browserHistoryList({ ...(text ? { text } : {}), before: last.lastVisitedAt, limit: PAGE + 1 })
      .then((found) => {
        if (latest.current !== ticket) return;
        setRows((shown) => [...(shown ?? []), ...found.slice(0, PAGE)]);
        setMore(found.length > PAGE);
      })
      .catch(() => {});
  }

  function forget(entry: HistoryEntry) {
    setRows((shown) => shown?.filter((row) => row.urlKey !== entry.urlKey) ?? null);
    void api.browserHistoryDelete(entry.urlKey).catch(() => setReload((n) => n + 1));
  }

  function clear(range: ClearRange) {
    const what = {
      hour: "Pages visited in the last hour are forgotten.",
      today: "Pages visited today are forgotten.",
      all: "Every page the browser has recorded is forgotten.",
    }[range];
    onConfirm({
      title: "Clear browsing history?",
      description: `${what} Open tabs stay as they are.`,
      action: "Clear",
      onConfirm: async () => {
        await api.browserHistoryClear(clearSince(range)).catch(() => {});
        setReload((n) => n + 1);
      },
    });
  }

  const days = rows ? groupByDay(rows) : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-10 py-12">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] leading-tight font-semibold tracking-[-0.26px]">History</h1>
          <Menu.Root modal={false}>
            <Menu.Trigger render={<Button variant="secondary" size="sm" className="ml-auto" />}>
              Clear…
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
                <Menu.Popup className={PANEL}>
                  {CLEAR_RANGES.map((item) => (
                    <Menu.Item key={item.id} className={ITEM} onClick={() => clear(item.id)}>
                      {item.label}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>

        <Input
          autoFocus
          aria-label="Search history"
          className="w-full"
          value={query}
          placeholder="Search by title or address"
          onChange={(event) => setQuery(event.target.value)}
        />

        {days === null ? null : days.length === 0 ? (
          <Blank searching={text !== ""} text={text} />
        ) : (
          <div className="flex flex-col gap-5">
            {days.map((day) => (
              <section key={day.key} className="flex flex-col">
                <h2 className="px-3 pb-1 text-[11px] font-semibold tracking-[0.06em] text-text-muted uppercase">
                  {day.label}
                </h2>
                {day.entries.map((entry) => (
                  <Row key={entry.urlKey} entry={entry} onOpen={onOpen} onForget={forget} />
                ))}
              </section>
            ))}
            {more && (
              <Button variant="secondary" size="sm" className="self-center" onClick={loadMore}>
                Show older
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  entry,
  onOpen,
  onForget,
}: {
  entry: HistoryEntry;
  onOpen: (url: string) => void;
  onForget: (entry: HistoryEntry) => void;
}) {
  const title = entry.title.trim() || entry.url;
  return (
    <div className="group flex items-center gap-1 rounded-chrome pr-1 transition-colors hover:bg-hover">
      <button
        type="button"
        onClick={() => onOpen(entry.url)}
        title={entry.url}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
      >
        <GlobeIcon className="size-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 shrink truncate text-[13px] text-text">{title}</span>
        <span className="min-w-0 shrink-[2] truncate text-[12px] text-placeholder">{hostOf(entry.url)}</span>
        <span className="ml-auto shrink-0 pl-3 text-[11px] text-placeholder tabular-nums">
          {clock(entry.lastVisitedAt)}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${title} from history`}
        title="Remove from history"
        onClick={() => onForget(entry)}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-selected hover:text-text focus-visible:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

function Blank({ searching, text }: { searching: boolean; text: string }) {
  if (searching) {
    return <p className="py-16 text-center text-[13px] text-text-muted">Nothing matches {`"${text}"`}.</p>;
  }
  return (
    <div className="flex flex-col items-center gap-2 py-20 text-center">
      <ClockCounterClockwiseIcon className="size-5 text-placeholder" />
      <p className="text-[13px] text-text-muted">Pages you open in the browser show up here.</p>
    </div>
  );
}
