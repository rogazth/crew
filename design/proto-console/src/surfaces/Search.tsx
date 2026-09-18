import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  RANGES,
  dayLabel,
  rangeStart,
  roleLabel,
  searchMessages,
  snippetRuns,
  type Range,
  type SearchHit,
} from "@crew/fixtures";
import {
  Button,
  CommandKbd,
  Empty,
  Hairline,
  InputWith,
  Kbd,
  ProviderMark,
  Segmented,
  Select,
} from "@/ui";
import { useRovingIndex } from "@/lib/hooks";
import { store, useApp } from "@/lib/store";

type Sort = "relevance" | "newest";

const SORTS = [
  { id: "relevance" as const, label: "Best" },
  { id: "newest" as const, label: "Newest" },
];

const EXAMPLES = ["ToolDetail", "provider", "spinner"];

export function SearchPage({ query }: { query: string }) {
  const state = useApp();
  const field = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  const [range, setRange] = useState<Range>("any");
  const [sort, setSort] = useState<Sort>("relevance");
  const [agent, setAgent] = useState<string>("all");

  const agents = useMemo(
    () => state.sessions.filter((s) => s.workspaceId === state.workspaceId && s.kind === "agent"),
    [state.sessions, state.workspaceId],
  );

  const hits = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const from = rangeStart(range, Date.now());
    return searchMessages({
      query: trimmed,
      sort,
      limit: 200,
      ...(from !== undefined ? { from } : {}),
      ...(agent !== "all" ? { sessionIds: [agent] } : {}),
    });
  }, [query, range, sort, agent]);

  const groups = useMemo(() => groupBySession(hits), [hits]);
  const flat = useMemo(() => groups.flatMap((group) => group.hits), [groups]);
  const [cursor, move, setCursor] = useRovingIndex(flat.length, `${query}|${range}|${sort}|${agent}`);

  useEffect(() => {
    field.current?.focus();
  }, []);

  useEffect(() => {
    list.current?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const open = (hit: SearchHit) => store.scrollTo(hit.sessionId, hit.id);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      const hit = flat[cursor];
      if (hit) {
        event.preventDefault();
        open(hit);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      store.closePage();
    }
  };

  let row = -1;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <InputWith
            className="flex-1"
            lead={<span className="font-mono text-xs">find</span>}
            trail={<CommandKbd id="search-messages" />}
          >
            <input
              ref={field}
              value={query}
              onChange={(event) => store.setSearchQuery(event.target.value)}
              placeholder="Search every message of every agent"
              spellCheck={false}
              aria-label="Search messages"
              className="min-w-0 flex-1 text-md placeholder:text-ink-4"
            />
          </InputWith>
          <Button onClick={() => store.closePage()} kbd={<Kbd>Esc</Kbd>}>
            Close
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Segmented value={range} options={RANGES} onChange={setRange} label="Time range" />
          <Select
            shape="chip"
            label="Agent"
            value={agent}
            onChange={setAgent}
            options={[
              { id: "all", label: "All agents" },
              ...agents.map((session) => ({
                id: session.id,
                label: session.name,
                note: session.provider,
              })),
            ]}
          />
          <Segmented value={sort} options={SORTS} onChange={setSort} label="Sort" />
          <span className="ml-auto font-mono text-xs text-ink-4">{countLabel(query, hits)}</span>
        </div>
      </div>

      <Hairline />

      <div ref={list} className="scroll min-h-0 flex-1">
        {!query.trim() ? (
          <Empty
            title="Type to search every message of every agent."
            hint="Full text over every transcript in the workspace — replies, prompts, reasoning and what each tool actually did."
          >
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-xs text-ink-4">try</span>
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    store.setSearchQuery(example);
                    field.current?.focus();
                  }}
                  className="rounded-[var(--r)] border border-rule bg-raised px-1.5 py-0.5 font-mono text-xs text-ink-2 hover:border-rule-strong hover:text-ink"
                >
                  {example}
                </button>
              ))}
            </div>
          </Empty>
        ) : flat.length === 0 ? (
          <Empty
            title={`No message matches “${query.trim()}”.`}
            hint={
              range === "any" && agent === "all"
                ? "Search is literal, not fuzzy — try a shorter word, or part of a path."
                : "The filters are narrowing it. Widen the time range or search every agent."
            }
          >
            {range !== "any" || agent !== "all" ? (
              <Button
                className="mt-1"
                onClick={() => {
                  setRange("any");
                  setAgent("all");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </Empty>
        ) : (
          <div className="pb-4">
            {groups.map((group) => (
              <div key={group.id}>
                <div className="grouprule px-4 pt-3 pb-1">
                  <ProviderMark provider={providerOf(state.sessions, group.id)} size={12} />
                  <span>{group.name}</span>
                  <span>{group.hits.length}</span>
                </div>
                {group.hits.map((hit) => {
                  row += 1;
                  return (
                    <Hit
                      key={`${hit.sessionId}-${hit.id}-${hit.pos}`}
                      hit={hit}
                      index={row}
                      cursor={cursor === row}
                      onFocus={setCursor}
                      onOpen={open}
                    />
                  );
                })}
              </div>
            ))}
            <div className="grouprule px-4 pt-3 text-ink-4">
              <span>end of results</span>
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                <Kbd>⏎</Kbd>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Hit({
  hit,
  index,
  cursor,
  onFocus,
  onOpen,
}: {
  hit: SearchHit;
  index: number;
  cursor: boolean;
  onFocus: (index: number) => void;
  onOpen: (hit: SearchHit) => void;
}) {
  return (
    <button
      type="button"
      data-row={index}
      aria-current={cursor}
      onPointerEnter={() => onFocus(index)}
      onClick={() => onOpen(hit)}
      className={clsx(
        "block w-full px-4 py-1.5 text-left transition-colors duration-[var(--fast)]",
        cursor ? "bg-raised" : "hover:bg-raised/60",
      )}
    >
      <div className="flex items-baseline gap-2 font-mono text-xs text-ink-4">
        <span className="truncate text-ink-3">{hit.sessionName}</span>
        <span>{roleLabel(hit.role)}</span>
        <span className="ml-auto shrink-0">{dayLabel(hit.at)}</span>
      </div>
      <p className={clsx("line-clamp-2 text-md", cursor ? "text-ink" : "text-ink-2")}>
        {snippetRuns(hit.snippet).map((run, at) =>
          run.hit ? (
            <mark key={at} className="bg-mark text-ink">
              {run.text}
            </mark>
          ) : (
            <span key={at}>{run.text}</span>
          ),
        )}
      </p>
    </button>
  );
}

type Group = { id: string; name: string; hits: SearchHit[] };

/** Session order follows the ranking: the best hit decides where its agent sits. */
function groupBySession(hits: SearchHit[]): Group[] {
  const groups: Group[] = [];
  for (const hit of hits) {
    const held = groups.find((group) => group.id === hit.sessionId);
    if (held) held.hits.push(hit);
    else groups.push({ id: hit.sessionId, name: hit.sessionName, hits: [hit] });
  }
  return groups;
}

function providerOf(sessions: { id: string; provider: string }[], id: string): string {
  return sessions.find((session) => session.id === id)?.provider ?? "claude";
}

function countLabel(query: string, hits: SearchHit[]): string {
  if (!query.trim()) return "";
  if (hits.length === 0) return "no results";
  return `${hits.length} result${hits.length === 1 ? "" : "s"}`;
}
