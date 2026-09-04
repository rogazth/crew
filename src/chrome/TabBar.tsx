import { Tabs } from "@base-ui/react/tabs";
import { CaretLeftIcon, CaretRightIcon, RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { X } from "./icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { Kbd } from "./Kbd";
import { ProviderIcon } from "./ProviderIcon";
import { StatusDot } from "./StatusDot";
import { StubIcon } from "./StubIcon";
import { TabLauncher, type Launch } from "./TabLauncher";
import { useCommand } from "../hooks/useCommand";
import { useModKeyHeld } from "../hooks/useModKeyHeld";
import { useTabOverflow } from "../hooks/useTabOverflow";
import { commandKeys } from "../lib/commands";
import { IS_MAC } from "../lib/hotkey";
import { tabHotkey, tabTitle } from "../lib/tabs";
import type { Session, Tab } from "../lib/types";

type Props = {
  /** With the sidebar hidden, the traffic lights land on this strip. */
  inset: boolean;
  tabs: Tab[];
  activeId: string | null;
  sessions: Session[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onLaunch: (launch: Launch) => void;
};

/** One 40px row of pill tabs, plus on the end. Every slot in a pill is fixed width. */
export function TabBar({ inset, tabs, activeId, sessions, onSelect, onClose, onLaunch }: Props) {
  const [launcher, setLauncher] = useState(false);
  const modHeld = useModKeyHeld();
  const strip = useTabOverflow(tabs.map((tab) => tab.id).join("|"));

  useCommand("open-launcher", () => setLauncher((value) => !value));

  // Selecting from the launcher or the sidebar can land on a tab that scrolled out of view.
  const { ref } = strip;
  useEffect(() => {
    if (!activeId) return;
    ref.current
      ?.querySelector(`[data-tab-id="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, ref]);

  return (
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-stretch border-b border-border bg-sidebar"
    >
      {inset && IS_MAC && <div className="w-[78px] shrink-0" />}
      <Tabs.Root
        value={activeId}
        onValueChange={(value) => onSelect(String(value))}
        className="relative isolate flex min-w-0 flex-1 items-center"
      >
        {/* One scroller carries the tabs and the plus, so the plus trails the last
            tab and sits flush left when there are none. */}
        <div
          ref={ref}
          className="no-scrollbar flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden px-1.5 scroll-px-10"
        >
          <Tabs.List className="flex h-full shrink-0 items-center gap-1">
            {tabs.map((tab, index) => {
              const active = tab.id === activeId;
              const hotkey = tabHotkey(index, tabs.length);
              const status = tabStatus(tab, sessions);
              const hint = modHeld && Boolean(hotkey);
              return (
                <Tabs.Tab
                  key={tab.id}
                  value={tab.id}
                  nativeButton={false}
                  render={<div />}
                  data-tab-id={tab.id}
                  data-tauri-drag-region="false"
                  onAuxClick={(event) => event.button === 1 && onClose(tab.id)}
                  title={tabTitle(tab, sessions)}
                  /* The ring and the shadow are always drawn; only their colour moves,
                     so the pill fades in instead of growing an edge. */
                  className={`group relative flex h-7 w-fit max-w-[190px] min-w-[120px] shrink-0 items-center gap-1.5 rounded-chrome pr-1.5 pl-2.5 shadow-[0_1px_2px_var(--tab-shadow)] ring-1 outline-none transition-[color,background-color,box-shadow] duration-150 ${
                    active
                      ? "bg-canvas text-text ring-hairline [--tab-shadow:var(--color-hairline)]"
                      : "bg-card text-text-muted ring-transparent hover:bg-hover [--tab-shadow:transparent]"
                  }`}
                >
                  <TabIcon tab={tab} sessions={sessions} />
                  <span className="min-w-0 flex-1 truncate">{tabTitle(tab, sessions)}</span>
                  {/* One fixed slot for three things that never coexist: the status
                      light, the close button it yields to on hover, and the jump hint
                      the modifier raises over both. Stacked, so no swap resizes the tab. */}
                  <span className="relative flex h-5 w-6 shrink-0 items-center justify-end">
                    {status && (
                      <span
                        className={`absolute inset-0 flex items-center justify-center transition-opacity ${
                          hint ? "opacity-0" : "opacity-100 group-hover:opacity-0"
                        }`}
                      >
                        <StatusDot status={status} />
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onClose(tab.id);
                      }}
                      aria-label="Close tab"
                      tabIndex={hint ? -1 : 0}
                      className={`absolute right-0 flex size-5 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-selected hover:text-text focus-visible:opacity-100 ${
                        hint
                          ? "pointer-events-none opacity-0"
                          : active && !status
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100"
                      }`}
                    >
                      <X className="size-3" />
                    </button>
                    {hotkey && (
                      <Kbd
                        keys={commandKeys(hotkey)}
                        className={`pointer-events-none absolute right-0 whitespace-nowrap transition-opacity ${
                          hint ? "opacity-100" : "opacity-0"
                        }`}
                      />
                    )}
                  </span>
                </Tabs.Tab>
              );
            })}
          </Tabs.List>

          <div className="flex shrink-0 items-center">
            <TabLauncher
              open={launcher}
              onOpenChange={setLauncher}
              sessions={sessions}
              onLaunch={onLaunch}
            />
          </div>
        </div>

        <ScrollControl
          side="start"
          visible={strip.canScrollStart}
          onClick={() => strip.scroll("start")}
        />
        <ScrollControl
          side="end"
          visible={strip.canScrollEnd}
          onClick={() => strip.scroll("end")}
        />
      </Tabs.Root>
    </div>
  );
}

/** kumo's Tabs overflow affordance: a gradient over the strip's edge with a caret on top. */
function ScrollControl({
  side,
  visible,
  onClick,
}: {
  side: "start" | "end";
  visible: boolean;
  onClick: () => void;
}) {
  const start = side === "start";
  const Caret = start ? CaretLeftIcon : CaretRightIcon;
  return (
    <button
      type="button"
      aria-label={start ? "Scroll tabs left" : "Scroll tabs right"}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onClick={onClick}
      data-tauri-drag-region="false"
      className={`absolute inset-y-0 z-10 flex w-10 items-center transition-opacity duration-150 ${
        start ? "left-0 justify-start bg-linear-to-r" : "right-0 justify-end bg-linear-to-l"
      } from-sidebar via-sidebar/95 to-transparent ${
        visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <span className="flex size-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-hover hover:text-text">
        <Caret className="size-3.5" />
      </span>
    </button>
  );
}

const tabStatus = (tab: Tab, sessions: Session[]) =>
  tab.kind === "session"
    ? (sessions.find((s) => s.id === tab.sessionId)?.status ?? null)
    : null;

/** Identity only — the status light lives in the tab's trailing slot. Every branch
    fills the same 14px box, so a tab keeps its layout when its kind changes. */
function TabIcon({ tab, sessions }: { tab: Tab; sessions: Session[] }) {
  const icon = () => {
    if (tab.kind === "stub") return <StubIcon stub={tab.stub} className="size-3.5 text-text-muted" />;
    if (tab.kind === "file") return <FileTypeIcon name={tab.relative} className="size-3.5" />;
    const session = sessions.find((s) => s.id === tab.sessionId);
    if (!session) return null;
    return session.kind === "agent" ? (
      <RobotIcon className="size-3.5 text-text-muted" />
    ) : (
      <ProviderIcon provider={session.provider} className="size-3.5" />
    );
  };
  return <span className="flex size-3.5 shrink-0 items-center justify-center">{icon()}</span>;
}
