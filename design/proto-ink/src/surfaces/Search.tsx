import { useEffect, useMemo, useRef, useState } from "react";
import {
  RANGES,
  dayLabel,
  rangeStart,
  roleLabel,
  snippetRuns,
  type Range,
  type SearchHit,
  type SessionKind,
} from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { SOURCE } from "@/lib/source";
import { useApp } from "@/lib/store";
import { Avatar, Button, Empty, Input, ScrollArea, Segmented, Select } from "@/ui";

const CAP = 100;
const SUGGESTIONS = ["ToolDetail", "harness", "approval"];

type Sort = "relevance" | "newest";

type Group = { sessionId: string; name: string; kind: SessionKind; hits: SearchHit[] };

/** Results keep search order; grouping only gathers each session's run of hits. */
function groupHits(hits: SearchHit[], kindOf: (sessionId: string) => SessionKind): Group[] {
  const groups: Group[] = [];
  const index = new Map<string, Group>();
  for (const hit of hits) {
    let group = index.get(hit.sessionId);
    if (!group) {
      group = {
        sessionId: hit.sessionId,
        name: hit.sessionName,
        kind: kindOf(hit.sessionId),
        hits: [],
      };
      index.set(hit.sessionId, group);
      groups.push(group);
    }
    group.hits.push(hit);
  }
  return groups;
}

export function Search() {
  const { sessions, activeWorkspaceId, searchSeed, actions } = useApp();

  const [query, setQuery] = useState(searchSeed.query);
  const [range, setRange] = useState<Range>("any");
  const [agent, setAgent] = useState("all");
  const [sort, setSort] = useState<Sort>("relevance");
  const [cursor, setCursor] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The palette and the demo menu push a query by bumping the token.
  const seenToken = useRef(searchSeed.token);
  useEffect(() => {
    if (searchSeed.token === seenToken.current) return;
    seenToken.current = searchSeed.token;
    setQuery(searchSeed.query);
    inputRef.current?.select();
  }, [searchSeed]);

  const agents = useMemo(
    () => sessions.filter((s) => s.workspaceId === activeWorkspaceId && s.kind === "agent"),
    [sessions, activeWorkspaceId],
  );

  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  // The source may be a socket, so a query is a request, not a function call.
  // A stale answer must not overwrite a fresh one.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const from = rangeStart(range, Date.now());
    void SOURCE.search({
      query: trimmed,
      ...(agent === "all" ? {} : { sessionIds: [agent] }),
      ...(from !== undefined ? { from } : {}),
      sort,
      limit: CAP + 1,
    }).then((found) => {
      if (!alive) return;
      setHits(found);
      setSearching(false);
    });
    return () => {
      alive = false;
    };
  }, [query, agent, range, sort]);

  const capped = hits.length > CAP;
  const groups = useMemo(
    () =>
      groupHits(
        hits.slice(0, CAP),
        (id) => sessions.find((s) => s.id === id)?.kind ?? "agent",
      ),
    [hits, sessions],
  );
  const flat = useMemo(() => groups.flatMap((group) => group.hits), [groups]);

  useEffect(() => {
    setCursor(0);
  }, [query, agent, range, sort]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>("[data-cursor]");
    node?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const open = (hit: SearchHit) => {
    actions.openSession(hit.sessionId);
    actions.focusBlock(hit.sessionId, hit.id);
  };

  // The page covers the whole surface, so the arrows belong to the result list
  // even while the caret sits in the field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (flat.length === 0) return;
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setCursor((prev) => Math.min(flat.length - 1, Math.max(0, prev + delta)));
        return;
      }
      if (event.key === "Enter") {
        const hit = flat[cursor];
        if (!hit) return;
        event.preventDefault();
        open(hit);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, cursor]);

  const filtered = range !== "any" || agent !== "all";
  const count = flat.length;
  const keyOf = (hit: SearchHit) => `${hit.sessionId}-${hit.id}-${hit.pos}`;
  const rowOf = useMemo(
    () => new Map(flat.map((hit, index) => [keyOf(hit), index])),
    [flat],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--stroke-tertiary)] px-3">
        <h1 className="text-body font-[var(--weight-medium)] text-primary">Search messages</h1>
        <span className="ml-auto text-small text-tertiary tnum">
          {query.trim() === ""
            ? ""
            : searching
              ? "Searching…"
              : count === 1
                ? "1 result"
                : `${count}${capped ? "+" : ""} results`}
        </span>
      </header>

      <div className="shrink-0 border-b border-[var(--stroke-tertiary)] bg-chrome px-3 py-2">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
          <Input
            ref={inputRef}
            autoFocus
            size="lg"
            icon="search"
            value={query}
            placeholder="Search every message…"
            aria-label="Search every message"
            className="min-w-0 flex-1"
            onChange={(event) => setQuery(event.target.value)}
          />
          <Segmented
            value={range}
            onChange={setRange}
            options={RANGES.map((entry) => ({ value: entry.id, label: entry.label }))}
          />
          <Select
            value={agent}
            onValueChange={setAgent}
            width={148}
            options={[
              { value: "all", label: "All agents" },
              ...agents.map((session) => ({ value: session.id, label: session.name })),
            ]}
          />
          <Segmented
            value={sort}
            onChange={setSort}
            options={[
              { value: "relevance", label: "Best" },
              { value: "newest", label: "Newest" },
            ]}
          />
        </div>
      </div>

      <ScrollArea ref={listRef} className="flex-1">
        <div className="mx-auto w-full max-w-3xl px-3 pb-10 pt-2">
          {query.trim() === "" && (
            <Empty
              icon="search"
              title="Search every message of every agent"
              description="Prose, tool output and file paths are all indexed."
              action={
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  {SUGGESTIONS.map((suggestion) => (
                    <Button
                      key={suggestion}
                      size="sm"
                      onClick={() => {
                        setQuery(suggestion);
                        inputRef.current?.focus();
                      }}
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
              }
            />
          )}

          {query.trim() !== "" && count === 0 && !searching && (
            <Empty
              icon="search"
              title={`No message matches “${query.trim()}”`}
              description={
                filtered
                  ? "The time range or the agent filter may be hiding it."
                  : "Try a shorter word, or a path from the tool output."
              }
              action={
                filtered ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setRange("any");
                      setAgent("all");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          )}

          {groups.map((group) => (
            <section key={group.sessionId} className="mb-1">
              <div className="flex items-center gap-2 px-2 pb-1 pt-4 text-micro uppercase tracking-[0.06em] text-quaternary">
                <span className="truncate">{group.name}</span>
                <span className="tnum">{group.hits.length}</span>
              </div>
              {group.hits.map((hit) => {
                const index = rowOf.get(keyOf(hit)) ?? 0;
                const active = index === cursor;
                return (
                  <button
                    key={keyOf(hit)}
                    type="button"
                    {...(active ? { "data-cursor": "" } : {})}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => open(hit)}
                    className={cx(
                      "relative flex w-full flex-col gap-1 rounded-row px-2 py-1.5 text-left",
                      "transition-colors duration-[var(--dur-1)]",
                      active ? "bg-[var(--fill-secondary)]" : "hover:bg-[var(--fill-tertiary)]",
                    )}
                  >
                    {active && (
                      <span
                        aria-hidden
                        className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--accent)]"
                      />
                    )}
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Avatar seed={group.name} size={16} kind={group.kind} />
                      <span className="truncate text-body text-primary">{group.name}</span>
                      <span className="truncate text-micro text-tertiary">
                        {roleLabel(hit.role)} · {dayLabel(hit.at)}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-small text-secondary">
                      {snippetRuns(hit.snippet).map((run, runIndex) =>
                        run.hit ? (
                          <mark
                            key={runIndex}
                            className="rounded-xs bg-[var(--mark-fill)] px-0.5 text-primary"
                          >
                            {run.text}
                          </mark>
                        ) : (
                          <span key={runIndex}>{run.text}</span>
                        ),
                      )}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}

          {capped && (
            <p className="px-2 pt-4 text-center text-micro text-quaternary">
              Showing the first {CAP} matches. Narrow the query to see the rest.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
