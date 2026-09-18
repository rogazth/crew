import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { IS_MAC, STUB_LABELS, type Tab } from "@crew/fixtures";
import { ProviderMark, StatusMark, TerminalMark } from "@/ui";
import { store, useApp } from "@/lib/store";
import { fileName } from "@/lib/format";

/** True while the tab-jump modifier is down, so the strip can show its numbers. */
function useModifierHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (IS_MAC ? event.key === "Meta" : event.key === "Control") setHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (IS_MAC ? event.key === "Meta" : event.key === "Control") setHeld(false);
    };
    const blur = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return held;
}

export function TabStrip() {
  const state = useApp();
  const tabs = state.tabsByWorkspace[state.workspaceId]?.tabs ?? [];
  const activeId = state.tabsByWorkspace[state.workspaceId]?.activeId ?? null;
  const held = useModifierHeld();
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const dragging = useRef<number | null>(null);

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    setEdges({
      left: node.scrollLeft > 2,
      right: node.scrollLeft + node.clientWidth < node.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    measure();
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, tabs.length]);

  useEffect(() => {
    const node = scroller.current;
    node?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeId]);

  const nudge = (delta: number) => {
    scroller.current?.scrollBy({ left: delta, behavior: "smooth" });
  };

  return (
    <div className="relative flex h-[var(--h-tabs)] shrink-0 items-stretch border-b border-rule bg-bg select-none">
      {edges.left ? (
        <EdgeButton side="left" onClick={() => nudge(-200)} />
      ) : null}
      <div ref={scroller} onScroll={measure} className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab, index) => (
          <TabPill
            key={tab.id}
            tab={tab}
            index={index}
            active={tab.id === activeId}
            held={held}
            onDragStart={() => {
              dragging.current = index;
            }}
            onDrop={() => {
              if (dragging.current !== null && dragging.current !== index) {
                store.moveTab(dragging.current, index);
              }
              dragging.current = null;
            }}
          />
        ))}
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={() => store.openOverlay({ kind: "launcher" })}
          className="grid w-7 shrink-0 place-items-center text-ink-4 hover:text-ink"
        >
          <Plus size={13} strokeWidth={1.25} />
        </button>
      </div>
      {edges.right ? <EdgeButton side="right" onClick={() => nudge(200)} /> : null}
    </div>
  );
}

function EdgeButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Scroll tabs left" : "Scroll tabs right"}
      onClick={onClick}
      className={clsx(
        "z-10 grid w-5 shrink-0 place-items-center bg-bg text-ink-3 hover:text-ink",
        side === "left" ? "border-r border-rule" : "border-l border-rule",
      )}
    >
      {side === "left" ? (
        <ChevronLeft size={13} strokeWidth={1.25} />
      ) : (
        <ChevronRight size={13} strokeWidth={1.25} />
      )}
    </button>
  );
}

function titleOf(tab: Tab): string {
  if (tab.kind === "file") return fileName(tab.relative);
  if (tab.kind === "stub") return STUB_LABELS[tab.stub] ?? tab.title;
  return store.session(tab.sessionId)?.name ?? tab.sessionId;
}

function TabPill({
  tab,
  index,
  active,
  held,
  onDragStart,
  onDrop,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  held: boolean;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const state = useApp();
  const session = tab.kind === "session" ? state.sessions.find((s) => s.id === tab.sessionId) : undefined;
  const dirty = tab.kind === "file" && state.dirty[tab.relative] !== undefined;
  const number = index + 1;
  const showNumber = number <= 8;

  return (
    <div
      data-active={active}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          store.requestCloseTab(tab.id);
        }
      }}
      className={clsx(
        "group relative flex shrink-0 items-center gap-1.5 border-r border-rule pr-1 pl-2",
        "font-mono text-sm transition-colors duration-[var(--fast)]",
        active ? "bg-ink text-on-ink" : "text-ink-2 hover:bg-raised hover:text-ink",
      )}
    >
      <button
        type="button"
        onClick={() => store.setActiveTab(tab.id)}
        className="flex min-w-0 items-center gap-1.5"
        title={tab.kind === "file" ? tab.relative : titleOf(tab)}
      >
        <span
          className={clsx(
            "grid h-[14px] min-w-[14px] shrink-0 place-items-center rounded-[var(--r)] px-[3px] text-xs leading-none transition-colors duration-[var(--fast)]",
            held && showNumber
              ? active
                ? "bg-on-ink text-ink"
                : "bg-accent text-accent-on"
              : active
                ? "text-on-ink opacity-50"
                : "text-ink-4",
          )}
        >
          {showNumber ? number : "·"}
        </span>
        <TabMark tab={tab} provider={session?.provider} kind={session?.kind} />
        <span className="max-w-[180px] truncate">{titleOf(tab)}</span>
      </button>

      {/* One fixed slot, three exclusive occupants, so nothing resizes. */}
      <span className="relative grid size-[14px] shrink-0 place-items-center">
        <span className="col-start-1 row-start-1 group-hover:opacity-0">
          {dirty ? (
            <span className="block size-[6px] rounded-full bg-current opacity-70" />
          ) : session ? (
            <StatusMark status={session.status} title={false} />
          ) : null}
        </span>
        <button
          type="button"
          aria-label={`Close ${titleOf(tab)}`}
          onClick={(event) => {
            event.stopPropagation();
            store.requestCloseTab(tab.id);
          }}
          className="col-start-1 row-start-1 grid size-[14px] place-items-center rounded-[var(--r)] opacity-0 group-hover:opacity-100 hover:bg-current/15"
        >
          <X size={11} strokeWidth={1.5} />
        </button>
      </span>
    </div>
  );
}

function TabMark({ tab, provider, kind }: { tab: Tab; provider?: string; kind?: string }) {
  if (tab.kind === "file") {
    const ext = tab.relative.split(".").pop()?.slice(0, 2) ?? "f";
    return (
      <span className="grid size-[14px] shrink-0 place-items-center rounded-[var(--r)] bg-current/10 text-[8px] leading-none">
        {ext}
      </span>
    );
  }
  if (tab.kind === "stub") {
    return (
      <span className="grid size-[14px] shrink-0 place-items-center rounded-[var(--r)] bg-current/10 text-[8px] leading-none">
        {tab.stub.slice(0, 2)}
      </span>
    );
  }
  if (kind === "terminal") return <TerminalMark />;
  return provider ? <ProviderMark provider={provider} /> : null;
}
