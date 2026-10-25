import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { FindBar } from "../../chrome/FindBar";
import { searchMessages } from "../../lib/api";
import { findTerms, matchOffsets } from "../../lib/chatFind";
import type { SearchHit } from "../../lib/protocol";
import { focus } from "../../lib/transcript";

/** Long enough that a held key does not fire a query per character. */
const DEBOUNCE_MS = 120;
/** A line the agent writes while the bar is open is found once the index has it: it flushes every 600ms. */
const REFRESH_MS = 800;
/** The most hits one query brings; the counter says "+" past it. */
const LIMIT = 500;
/** How many frames to wait for a folded phase to mount the row it holds. */
const FOCUS_FRAMES = 30;
/** The band a match has to sit in to count as seen: clear of the bar above and of the edge below. */
const TOP_PX = 56;
const FOOT_PX = 24;
/** How long the marks wait after the transcript changes: a streaming turn changes it every frame. */
const REPAINT_MS = 120;
/** A wait for history worth saying so. Shorter, the counter would only flicker. */
const BUSY_MS = 160;

/** The names `::highlight()` paints in index.css. One chat finds at a time, so they are shared. */
const MATCH = "crew-find";
const CURRENT = "crew-find-current";

/** What each chat last looked for: ⌘F again offers it, selected. */
const lastQuery = new Map<string, string>();

type Props = {
  sessionId: string;
  active: boolean;
  /** Bumped by ⌘F, so a second press selects the field again. */
  token: number;
  /** The chat surface: the transcript scrolls inside it. */
  root: RefObject<HTMLElement | null>;
  /** Changes with the transcript, so a line written while the bar is open is found too. */
  revision: number;
  onClose: () => void;
};

const highlights = () => (typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null);

function clearMarks() {
  highlights()?.delete(MATCH);
  highlights()?.delete(CURRENT);
}

/**
 * The text a block shows, as ranges over each match. A folded row's trigger
 * carries the block's id and its panel the rest, so an open panel counts too.
 * Text nobody can see (an invisible bold twin, an aria-hidden glyph) is left
 * out, or a step would land on a match that is not there.
 */
function rangesIn(block: Element, terms: string[]): Range[] {
  const roots = [block];
  const panel = block.getAttribute("aria-controls");
  const opened = panel ? document.getElementById(panel) : null;
  if (opened && !block.contains(opened)) roots.push(opened);
  const seen = new Map<Element, boolean>();
  const visible = (el: Element) => {
    let answer = seen.get(el);
    if (answer === undefined) {
      answer = !el.closest("[aria-hidden='true']") && el.checkVisibility({ checkVisibilityCSS: true });
      seen.set(el, answer);
    }
    return answer;
  };
  const ranges: Range[] = [];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const text = node.data;
      if (!text.trim() || !node.parentElement || !visible(node.parentElement)) continue;
      for (const [from, to] of matchOffsets(text, terms)) {
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

/** The transcript's scroller inside a chat surface. */
function scrollerIn(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>("[data-selectable='blocks']") ?? null;
}

function rowIn(scroller: HTMLElement | null, id: string): Element | null {
  return scroller?.querySelector(`[data-block="${CSS.escape(id)}"]`) ?? null;
}

type Marking = { hits: SearchHit[] | null; target: { id: string } | null; terms: string[]; active: boolean };

/** Marks every match on screen, the current message's brighter. Answers that message's first one. */
function paint(scroller: HTMLElement | null, { hits, target, terms, active }: Marking): Range | undefined {
  const registry = highlights();
  if (!registry || !scroller || !active || !hits?.length || terms.length === 0) {
    clearMarks();
    return undefined;
  }
  const others: Range[] = [];
  const mine: Range[] = [];
  for (const hit of hits) {
    const row = rowIn(scroller, hit.id);
    if (row) (hit.id === target?.id ? mine : others).push(...rangesIn(row, terms));
  }
  registry.set(MATCH, new Highlight(...others));
  const current = new Highlight(...mine);
  current.priority = 1;
  registry.set(CURRENT, current);
  return mine[0];
}

/** Where to look: the hit nearest the reader, counting up from the bottom of what they see. */
function nearest(hits: SearchHit[], scroller: HTMLElement | null): SearchHit | undefined {
  if (!scroller || scroller.clientHeight === 0) return hits[0];
  const bottom = scroller.getBoundingClientRect().bottom;
  // Newest first. A hit with no row is in history not loaded yet, or folded,
  // so above the reader either way.
  return (
    hits.find((hit) => {
      const row = rowIn(scroller, hit.id);
      return !row || row.getBoundingClientRect().top < bottom;
    }) ?? hits.at(-1)
  );
}

/** Scroll `rect` into the middle of the scroller, unless it is already in plain sight. */
function bringIntoView(scroller: HTMLElement, rect: DOMRect) {
  const box = scroller.getBoundingClientRect();
  if (rect.top >= box.top + TOP_PX && rect.bottom <= box.bottom - FOOT_PX) return;
  // A row taller than the window shows its top, a third of the way down.
  const height = Math.min(rect.height, box.height / 3);
  scroller.scrollTop += rect.top - box.top - (box.height - height) / 2;
}

/** A hit whose words are folded out of sight (a tool's command, a letter): the row lights instead. */
function flash(row: Element) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  row.animate(
    [
      { backgroundColor: "color-mix(in srgb, var(--color-accent) 18%, transparent)", borderRadius: "8px" },
      { backgroundColor: "transparent", borderRadius: "8px" },
    ],
    { duration: 1600, easing: "ease-out" },
  );
}

/**
 * ⌘F in a chat. The daemon's index finds the blocks, so a match in history not
 * loaded yet, or folded behind "Worked for 4m", counts as much as one on
 * screen: stepping to it loads the pages and opens the fold. The words are
 * marked with the CSS Highlight API, which paints over the text without
 * touching a DOM that React and a streaming turn both own.
 *
 * A step goes a message at a time, newest first, because the counter counts
 * messages: the index answers per block, not per word.
 */
export function ChatFind({ sessionId, active, token, root, revision, onClose }: Props) {
  const [query, setQuery] = useState(() => lastQuery.get(sessionId) ?? "");
  /** Newest first. Kept while the next query is on its way, so the count does not blink. */
  const [found, setFound] = useState<SearchHit[] | null>(null);
  /** The hit the reader is on. `seq` makes a step to the same hit (one in all) go there again. */
  const [target, setTarget] = useState<{ id: string; seq: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const terms = useMemo(() => findTerms(query), [query]);
  const hits = useMemo(() => (terms.length === 0 ? [] : found), [terms, found]);

  // What a callback that outlives a render reads.
  const live = useRef({ hits, target, terms, active });
  useEffect(() => {
    live.current = { hits, target, terms, active };
  });

  const write = (value: string) => {
    setQuery(value);
    lastQuery.set(sessionId, value);
  };

  // A new query asks at once and goes to the nearest hit; a transcript that
  // grew asks again later and keeps the reader where they are.
  const searched = useRef<string | null>(null);
  useEffect(() => {
    if (findTerms(query).length === 0) {
      searched.current = null;
      return;
    }
    const fresh = searched.current !== query;
    let stale = false;
    const timer = window.setTimeout(() => {
      void searchMessages({ query, sessionIds: [sessionId], limit: LIMIT, sort: "newest" })
        .then((answer) => {
          if (stale) return;
          searched.current = query;
          const sorted = [...answer].sort((a, b) => b.pos - a.pos);
          setFound(sorted);
          const held = live.current.target;
          // A chat behind another tab is not moved by a line its agent wrote.
          if (!fresh && (!live.current.active || (held && sorted.some((hit) => hit.id === held.id)))) return;
          const next = nearest(sorted, scrollerIn(root.current));
          setTarget((was) => (next ? { id: next.id, seq: (was?.seq ?? 0) + 1 } : null));
        })
        .catch(() => {
          if (!stale) setFound([]);
        });
    }, fresh ? DEBOUNCE_MS : REFRESH_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [query, sessionId, revision, root]);

  useEffect(() => {
    paint(scrollerIn(root.current), { hits, target, terms, active });
  }, [root, hits, target, terms, active]);
  useEffect(() => clearMarks, []);

  // Streaming text, a fold opening, a page of history landing: each one moves
  // or replaces the text the marks sit on.
  useEffect(() => {
    const el = scrollerIn(root.current);
    if (!el || !active) return;
    let timer = 0;
    const observer = new MutationObserver(() => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        paint(el, live.current);
      }, REPAINT_MS);
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [root, active]);

  // Go to the hit: load the history it is in, open what folds it, then put its
  // first word in the middle of the window.
  useEffect(() => {
    const hit = target && live.current.hits?.find((one) => one.id === target.id);
    if (!hit) return;
    let cancelled = false;
    let frame = 0;
    const slow = window.setTimeout(() => setBusy(true), BUSY_MS);
    void focus(sessionId, hit.pos, Number.POSITIVE_INFINITY).then(() => {
      window.clearTimeout(slow);
      setBusy(false);
      if (cancelled) return;
      let frames = 0;
      const look = () => {
        if (cancelled) return;
        const el = scrollerIn(root.current);
        const row = rowIn(el, hit.id);
        if (row && el) {
          const first = paint(el, live.current);
          bringIntoView(el, (first ?? row).getBoundingClientRect());
          if (!first) flash(row);
          return;
        }
        frames += 1;
        if (frames <= FOCUS_FRAMES) frame = window.requestAnimationFrame(look);
      };
      look();
    });
    return () => {
      cancelled = true;
      window.clearTimeout(slow);
      window.cancelAnimationFrame(frame);
    };
  }, [target, sessionId, root]);

  const step = (delta: number) => {
    if (!hits?.length) return;
    const at = hits.findIndex((hit) => hit.id === target?.id);
    // Newest first, so up the transcript is further down the list.
    const next = at < 0 ? 0 : (at - delta + hits.length) % hits.length;
    setTarget((was) => ({ id: hits[next]!.id, seq: (was?.seq ?? 0) + 1 }));
  };

  const at = hits && target ? hits.findIndex((hit) => hit.id === target.id) : -1;
  const summary =
    terms.length === 0 || hits === null
      ? undefined
      : hits.length === 0
        ? { text: "No results", empty: true }
        : { text: `${Math.max(at, 0) + 1} of ${hits.length}${hits.length >= LIMIT ? "+" : ""}`, busy };

  return (
    <FindBar
      label="Find in chat"
      query={query}
      results={{ index: Math.max(at, 0), count: hits?.length ?? 0 }}
      focusToken={token}
      onQuery={write}
      onStep={step}
      onClose={onClose}
      enterGoesUp
      stepLabels={{ up: "Older match", down: "Newer match" }}
      {...(summary ? { summary } : {})}
    />
  );
}
