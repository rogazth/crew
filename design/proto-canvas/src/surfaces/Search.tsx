import { useEffect, useState } from "react";
import {
  RANGES,
  dayLabel,
  rangeStart,
  roleLabel,
  snippetRuns,
  type Range,
  type SearchHit,
} from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { source } from "@/lib/source";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Empty } from "@/ui/Empty";
import { Icon } from "@/ui/Icon";
import { Input } from "@/ui/Input";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";

export function SearchPage() {
  const { wsSessions, revealBlock, page, setPage } = useStore();
  const query = page?.kind === "search" ? page.query : "";
  const [range, setRange] = useState<Range>("any");
  const [agent, setAgent] = useState<string>("all");
  const [sort, setSort] = useState<"relevance" | "newest">("relevance");

  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let alive = true;
    setSearching(true);
    const from = rangeStart(range, Date.now());
    void source
      .search({
        query,
        ...(agent === "all" ? {} : { sessionIds: [agent] }),
        ...(from !== undefined ? { from } : {}),
        sort,
      })
      .then((found) => {
        if (!alive) return;
        setHits(found);
        setSearching(false);
      });
    return () => {
      alive = false;
    };
  }, [query, range, agent, sort]);

  const agents = wsSessions.filter((session) => session.kind === "agent");

  return (
    <div className="scroller min-h-0 flex-1">
      <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-10">
        <h1 className="mb-1 text-xl">Search messages</h1>
        <p className="mb-6 text-base text-ink-52">Every message of every agent in this workspace.</p>

        <Input
          autoFocus
          value={query}
          onChange={(event) => setPage({ kind: "search", query: event.target.value })}
          placeholder="Search…"
          className="h-11 text-md"
          leading={<Icon name="search" size={18} className="text-ink-38" />}
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            value={range}
            onChange={setRange}
            options={RANGES.map((entry) => ({ value: entry.id, label: entry.label }))}
          />
          <Select
            size="sm"
            value={agent}
            onChange={setAgent}
            options={[
              { value: "all", label: "All agents" },
              ...agents.map((session) => ({ value: session.id, label: session.name })),
            ]}
          />
          <Segmented
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: "relevance", label: "Best" },
              { value: "newest", label: "Newest" },
            ]}
          />
          <span className="flex-1" />
          {query.trim() && (
            <span className="text-sm text-ink-52">
              {searching ? "searching…" : `${hits.length} ${hits.length === 1 ? "result" : "results"}`}
            </span>
          )}
        </div>

        <div className="mt-5 flex flex-col gap-1.5">
          {!query.trim() && (
            <Empty
              icon="search"
              title="Search every transcript"
              description="Type to search across all agents. Hits open the agent and scroll to the exact message."
            />
          )}
          {query.trim() && hits.length === 0 && !searching && (
            <Empty icon="circleAlert" title={`No matches for “${query}”`} description="Try a shorter query or widen the time range." />
          )}
          {hits.map((hit) => (
            <button
              key={`${hit.sessionId}-${hit.id}`}
              type="button"
              onClick={() => revealBlock(hit.sessionId, hit.id)}
              className="rise-1 flex w-full gap-3 rounded-card bg-raised px-3.5 py-3 text-left el-1"
            >
              <Avatar seed={hit.sessionName} size={28} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-base font-medium text-ink">{hit.sessionName}</span>
                  <span className="shrink-0 text-xs text-ink-52">{roleLabel(hit.role)}</span>
                  <span className="flex-1" />
                  <span className="shrink-0 text-xs text-ink-38">{dayLabel(hit.at)}</span>
                </span>
                <span className="mt-1 line-clamp-2 block text-sm text-ink-70">
                  {snippetRuns(hit.snippet).map((run, index) => (
                    <span
                      key={index}
                      className={cx(run.hit && "rounded-[3px] bg-[var(--mark-bg)] px-0.5 text-[var(--mark-ink)]")}
                    >
                      {run.text}
                    </span>
                  ))}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
