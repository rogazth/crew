import { ArrowUpDownIcon, BotIcon, CalendarIcon, CornerDownLeftIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentAvatar } from "../chrome/AgentAvatar";
import { FilterChip, PageFrame, type Option } from "../chrome/kit";
import { searchMessages } from "../lib/api";
import type { SearchHit, SearchSort } from "../lib/protocol";
import { RANGES, rangeStart, roleLabel, snippetRuns, type Range } from "../lib/search";
import { dayLabel } from "../lib/time";
import type { Session } from "../lib/types";

type Props = {
  /** Agents of the active workspace, for the "in" filter. */
  agents: Session[];
  /** Opens the agent and takes the reader to that line. */
  onOpenHit: (sessionId: string, pos: number) => void;
};

const SORTS: Option<SearchSort>[] = [
  { value: "relevance", label: "Best match" },
  { value: "newest", label: "Newest first" },
];

const RANGE_OPTIONS: Option<Range>[] = RANGES.map((item) => ({ value: item.id, label: item.label }));

/** Long enough that a held key does not fire a query per character. */
const DEBOUNCE_MS = 120;
/** What the page shows. One more is asked for, to know whether to say "+". */
const PAGE = 100;

/**
 * Every message every agent wrote, searchable. The daemon answers from an FTS5
 * index, so this stays a keystroke away from the answer even on a year of
 * transcripts; the debounce is for the round trip, not for the query.
 */
export function SearchView({ agents, onOpenHit }: Props) {
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<Range>("any");
  const [sort, setSort] = useState<SearchSort>("relevance");
  const [inSession, setInSession] = useState<string>("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Answers can land out of order; only the newest query may paint.
  const latest = useRef(0);

  const text = query.trim();
  // An empty box shows the blank state without clearing state from an effect:
  // whatever the last query found stays put until the next one answers.
  const showing = text === "" ? null : hits;

  useEffect(() => {
    if (text === "") return;
    const ticket = latest.current + 1;
    latest.current = ticket;
    const timer = window.setTimeout(() => {
      const from = rangeStart(range, Date.now());
      searchMessages({
        query: text,
        sessionIds: inSession ? [inSession] : [],
        ...(from === undefined ? {} : { from }),
        sort,
        limit: PAGE + 1,
      })
        .then((rows) => {
          if (latest.current !== ticket) return;
          setHits(rows);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (latest.current !== ticket) return;
          setError(reason instanceof Error ? reason.message : String(reason));
          setHits([]);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, range, sort, inSession]);

  const agentItems = useMemo(
    (): Option<string>[] => [
      { value: "", label: "All agents" },
      ...agents.map((agent) => ({
        value: agent.id,
        label: agent.name,
        icon: <AgentAvatar seed={agent.id} bare className="size-4" />,
      })),
    ],
    [agents],
  );

  return (
    <PageFrame title="Search" subtitle="Every message, from every agent, back to the first one.">
      <div className="flex flex-col gap-3">
        <label className="crew-well flex h-12 items-center gap-3 px-4">
          <SearchIcon className="size-4.5 shrink-0 text-icon" />
          <input
            autoFocus
            aria-label="Search messages"
            spellCheck={false}
            value={query}
            placeholder="Search messages…"
            onChange={(event) => setQuery(event.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
          {showing !== null && (
            <span className="shrink-0 text-[12px] text-text-muted tabular-nums">{countLabel(showing.length)}</span>
          )}
        </label>

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip label="When" icon={CalendarIcon} value={range} neutral="any" options={RANGE_OPTIONS} onChange={setRange} />
          <FilterChip label="Agent" icon={BotIcon} value={inSession} neutral="" options={agentItems} onChange={setInSession} />
          <FilterChip label="Sort" icon={ArrowUpDownIcon} value={sort} neutral="relevance" options={SORTS} onChange={setSort} />
        </div>
      </div>

      {error !== null && <p className="text-[13px] text-danger">{error}</p>}
      {showing === null ? (
        <Blank />
      ) : showing.length === 0 ? (
        <p className="py-16 text-center text-[13px] text-text-muted">Nothing matches {`"${text}"`}.</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {showing.slice(0, PAGE).map((hit) => (
            <HitRow key={`${hit.sessionId}:${hit.pos}`} hit={hit} onOpen={onOpenHit} />
          ))}
        </div>
      )}
    </PageFrame>
  );
}

/** Never claim a count the page did not actually reach. */
function countLabel(found: number): string {
  if (found > PAGE) return `${PAGE}+ results`;
  return found === 1 ? "1 result" : `${found} results`;
}

function HitRow({
  hit,
  onOpen,
}: {
  hit: SearchHit;
  onOpen: (sessionId: string, pos: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(hit.sessionId, hit.pos)}
      className="group flex items-start gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover"
    >
      <AgentAvatar seed={hit.sessionId} bare className="mt-0.5 size-6" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[12px] leading-4">
          <span className="font-medium text-text">{hit.sessionName}</span>
          <span className="text-text-muted">{roleLabel(hit)}</span>
          <span className="ml-auto text-text-muted tabular-nums">{dayLabel(hit.at)}</span>
        </span>
        <span className="line-clamp-2 text-[13px] leading-[19px] text-text-muted">
          {snippetRuns(hit.snippet).map((run, index) =>
            run.hit ? (
              <mark key={index} className="rounded-[4px] bg-warning/20 px-0.5 text-text">
                {run.text}
              </mark>
            ) : (
              <span key={index}>{run.text}</span>
            ),
          )}
        </span>
      </span>
      <CornerDownLeftIcon className="mt-1 size-3.5 shrink-0 text-icon opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

function Blank() {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <span className="grid size-10 place-items-center rounded-xl bg-card ring-1 ring-hairline">
        <SearchIcon className="size-4.5 text-icon" />
      </span>
      <p className="max-w-64 text-[13px] text-text-muted">Type to search. Filters narrow by when, who and how it ranks.</p>
    </div>
  );
}
