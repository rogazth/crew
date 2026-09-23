import { Input, Select, Tabs } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchMessages } from "../lib/api";
import type { SearchHit, SearchSort } from "../lib/protocol";
import { RANGES, roleLabel, snippetRuns, type Range } from "../lib/search";
import { countLabel, failureText, SEARCH_PAGE, searchQuery } from "../lib/searchView";
import { dayLabel } from "../lib/time";
import type { Session } from "../lib/types";

type Props = {
  /** Agents of the active workspace, for the "in" filter. */
  agents: Session[];
  /** Opens the agent and takes the reader to that line. */
  onOpenHit: (sessionId: string, pos: number) => void;
};

const SORTS: { value: SearchSort; label: string }[] = [
  { value: "relevance", label: "Best" },
  { value: "newest", label: "Newest" },
];

/** Long enough that a held key does not fire a query per character. */
const DEBOUNCE_MS = 120;

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
      searchMessages(searchQuery(text, range, sort, inSession, Date.now()))
        .then((rows) => {
          if (latest.current !== ticket) return;
          setHits(rows);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (latest.current !== ticket) return;
          setError(failureText(reason));
          setHits([]);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, range, sort, inSession]);

  const agentItems = useMemo(
    () => [
      { value: "", label: "All agents" },
      ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
    ],
    [agents],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-10 py-12">
        <h1 className="text-[20px] leading-tight font-semibold tracking-[-0.26px]">Search</h1>

        <Input
          autoFocus
          aria-label="Search messages"
          className="w-full"
          value={query}
          placeholder="Search every message"
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            variant="segmented"
            size="sm"
            tabs={RANGES.map((item) => ({ value: item.id, label: item.label }))}
            value={range}
            onValueChange={(value) => setRange(value as Range)}
          />
          <Select
            aria-label="Agent"
            size="sm"
            className="w-44"
            value={inSession}
            onValueChange={(value) => setInSession(value ?? "")}
            items={agentItems}
          />
          <Tabs
            variant="segmented"
            size="sm"
            tabs={SORTS}
            value={sort}
            onValueChange={(value) => setSort(value as SearchSort)}
          />
          {showing !== null && (
            <span className="ml-auto text-[11px] text-placeholder tabular-nums">
              {countLabel(showing.length)}
            </span>
          )}
        </div>

        {error !== null && <p className="text-[13px] text-danger">{error}</p>}
        {showing === null ? (
          <Blank />
        ) : showing.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-text-muted">Nothing matches {`"${text}"`}.</p>
        ) : (
          <div className="flex flex-col">
            {showing.slice(0, SEARCH_PAGE).map((hit) => (
              <HitRow key={`${hit.sessionId}:${hit.pos}`} hit={hit} onOpen={onOpenHit} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
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
      className="flex flex-col gap-1 rounded-chrome border-b border-hairline px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-hover"
    >
      <span className="flex items-center gap-2 text-[11px] leading-4 text-placeholder">
        <span className="font-medium text-text-muted">{hit.sessionName}</span>
        <span>{roleLabel(hit)}</span>
        <span className="ml-auto tabular-nums">{dayLabel(hit.at)}</span>
      </span>
      <span className="line-clamp-2 text-[13px] leading-[18px] text-text-muted">
        {snippetRuns(hit.snippet).map((run, index) =>
          run.hit ? (
            <mark key={index} className="rounded-[3px] bg-selected px-0.5 text-text">
              {run.text}
            </mark>
          ) : (
            <span key={index}>{run.text}</span>
          ),
        )}
      </span>
    </button>
  );
}

function Blank() {
  return (
    <div className="flex flex-col items-center gap-2 py-20 text-center">
      <MagnifyingGlassIcon className="size-5 text-placeholder" />
      <p className="text-[13px] text-text-muted">
        Every message, from every agent, back to the first one.
      </p>
    </div>
  );
}
