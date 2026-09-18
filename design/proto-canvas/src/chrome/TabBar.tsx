import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { STUB_LABELS, commandKeys, type Tab } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { IconButton } from "@/ui/Button";
import { Icon, type GlyphName } from "@/ui/Icon";
import { Kbd } from "@/ui/Kbd";
import { StatusDot } from "./StatusDot";
import { DemoMenu } from "./DemoMenu";
import { SourceBadge } from "./SourceBadge";
import { TabLauncher } from "./TabLauncher";

const TRAFFIC_LIGHTS = 78;

/** Held-modifier detection, so a pill can show its hotkey without a click. */
function useModHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") setHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") setHeld(false);
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

export function TabBar() {
  const { tabState, activateTab, requestCloseTab, sessionById, statusOf, sidebarCollapsed, toggleSidebar, moveTabTo } =
    useStore();
  const modHeld = useModHeld();
  const stripRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const measure = () => {
    const el = stripRef.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  };

  useLayoutEffect(measure, [tabState.tabs.length]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    const active = el?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabState.activeId]);

  const scrollBy = (delta: number) => stripRef.current?.scrollBy({ left: delta, behavior: "smooth" });

  return (
    <div className="relative flex h-11 shrink-0 items-center gap-1 border-b border-[var(--line-soft)] bg-sunken pr-2">
      {sidebarCollapsed && <div className="shrink-0" style={{ width: TRAFFIC_LIGHTS }} />}
      <IconButton
        icon="panelLeft"
        label={`Toggle sidebar (${commandKeys("toggle-sidebar")})`}
        size="sm"
        variant="ghost"
        className="ml-2 shrink-0"
        onClick={toggleSidebar}
      />

      {edges.left && (
        <IconButton icon="chevronLeft" label="Scroll tabs left" size="sm" variant="ghost" onClick={() => scrollBy(-240)} />
      )}

      <div
        ref={stripRef}
        onScroll={measure}
        className={cx(
          "no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1",
          edges.left && edges.right ? "mask-fade-both" : edges.right ? "mask-fade-r" : edges.left ? "mask-fade-l" : "",
        )}
      >
        {tabState.tabs.map((tab, index) => (
          <TabPill
            key={tab.id}
            tab={tab}
            index={index}
            active={tab.id === tabState.activeId}
            modHeld={modHeld}
            onActivate={() => activateTab(tab.id)}
            onClose={() => requestCloseTab(tab.id)}
            onDragStart={() => setDragFrom(index)}
            onDrop={() => {
              if (dragFrom !== null) moveTabTo(dragFrom, index);
              setDragFrom(null);
            }}
            title={
              tab.kind === "session"
                ? (sessionById(tab.sessionId)?.name ?? "session")
                : tab.kind === "file"
                  ? tab.relative.split("/").pop()!
                  : tab.title
            }
            status={tab.kind === "session" ? statusOf(tab.sessionId) : undefined}
            seed={tab.kind === "session" ? sessionById(tab.sessionId)?.name : undefined}
            terminal={tab.kind === "session" && sessionById(tab.sessionId)?.kind === "terminal"}
          />
        ))}
      </div>

      {edges.right && (
        <IconButton icon="chevronRight" label="Scroll tabs right" size="sm" variant="ghost" onClick={() => scrollBy(240)} />
      )}

      <SourceBadge />
      <DemoMenu />
      <TabLauncher />
    </div>
  );
}

const STUB_ICON: Record<string, GlyphName> = {
  terminal: "terminal",
  browser: "globe",
  sidechat: "bot",
};

function TabPill({
  tab,
  index,
  active,
  modHeld,
  title,
  status,
  seed,
  terminal,
  onActivate,
  onClose,
  onDragStart,
  onDrop,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  modHeld: boolean;
  title: string;
  status?: import("@crew/fixtures").SessionStatus;
  seed?: string;
  terminal?: boolean;
  onActivate: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const [hover, setHover] = useState(false);
  const hotkey = index < 8 ? commandKeys(`tab-${index + 1}` as "tab-1") : null;
  const showKey = modHeld && hotkey !== null;
  const showClose = hover && !showKey;

  return (
    <div
      data-active={active}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={onActivate}
      className={cx(
        "rise-1 group flex h-8 max-w-[210px] shrink-0 cursor-default select-none items-center gap-2 rounded-control pl-2 pr-1.5",
        active ? "bg-raised text-ink el-2" : "text-ink-52 hover:bg-raised hover:text-ink hover:el-1",
      )}
    >
      <span className="grid size-5 shrink-0 place-items-center">
        {tab.kind === "session" && seed && !terminal ? (
          <Avatar seed={seed} size={20} />
        ) : (
          <Icon
            name={
              tab.kind === "file"
                ? "fileCode"
                : tab.kind === "stub"
                  ? (STUB_ICON[tab.stub] ?? "square")
                  : "terminal"
            }
            size={15}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {tab.kind === "stub" ? (STUB_LABELS[tab.stub] ?? title) : title}
      </span>

      {/* One fixed slot, three stacked contents: nothing resizes on hover. */}
      <span className="relative grid size-5 shrink-0 place-items-center">
        <span
          className={cx(
            "absolute transition-opacity duration-[120ms]",
            showClose || showKey ? "opacity-0" : "opacity-100",
          )}
        >
          {status ? <StatusDot status={status} /> : <span className="size-2" />}
        </span>
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className={cx(
            "absolute grid size-5 place-items-center rounded-chip transition-opacity duration-[120ms] hover:bg-sunken",
            showClose ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <Icon name="x" size={13} />
        </button>
        <span
          className={cx(
            "pointer-events-none absolute transition-opacity duration-[120ms]",
            showKey ? "opacity-100" : "opacity-0",
          )}
        >
          {hotkey && <Kbd className="h-4 px-1 text-2xs">{hotkey}</Kbd>}
        </span>
      </span>
    </div>
  );
}
