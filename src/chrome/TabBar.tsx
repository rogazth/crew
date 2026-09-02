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
import { tabHotkey, tabTitle } from "../lib/tabs";
import type { Session, Tab } from "../lib/types";

type Props = {
  tabs: Tab[];
  activeId: string | null;
  sessions: Session[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onLaunch: (launch: Launch) => void;
};

/** R2's tab strip: one 40px row, full-height tabs divided by hairlines, plus on the end. */
export function TabBar({ tabs, activeId, sessions, onSelect, onClose, onLaunch }: Props) {
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
      <Tabs.Root
        value={activeId}
        onValueChange={(value) => onSelect(String(value))}
        className="relative isolate flex min-w-0 flex-1 items-stretch"
      >
        {/* One scroller carries the tabs and the plus, so the plus trails the last
            tab and sits flush left when there are none. */}
        <div
          ref={ref}
          className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden scroll-px-10"
        >
          <Tabs.List className="flex shrink-0 items-stretch">
            {tabs.map((tab, index) => {
              const active = tab.id === activeId;
              const hotkey = tabHotkey(index, tabs.length);
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
                  className={`group relative flex w-[190px] shrink-0 items-center gap-2 border-l border-border px-3 outline-none transition-colors ${
                    active
                      ? "bg-canvas text-text before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-kumo-default"
                      : "text-text-muted hover:bg-hover"
                  }`}
                >
                  <TabIcon tab={tab} sessions={sessions} />
                  <span className="min-w-0 flex-1 truncate">{tabTitle(tab, sessions)}</span>
                  <TabStatus tab={tab} sessions={sessions} />
                  {/* Holding the modifier turns the close slot into the jump hint. */}
                  {modHeld && hotkey ? (
                    <Kbd keys={commandKeys(hotkey)} className="shrink-0" />
                  ) : (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onClose(tab.id);
                      }}
                      aria-label="Close tab"
                      className={`flex size-5 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors group-hover:opacity-100 hover:bg-selected hover:text-text focus-visible:opacity-100 ${
                        active ? "opacity-100" : "opacity-0"
                      }`}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </Tabs.Tab>
              );
            })}
          </Tabs.List>

          <div className="flex shrink-0 items-center border-l border-border px-1.5">
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

function TabStatus({ tab, sessions }: { tab: Tab; sessions: Session[] }) {
  if (tab.kind !== "session") return null;
  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) return null;
  return <StatusDot status={session.status} className="size-1.5" />;
}

function TabIcon({ tab, sessions }: { tab: Tab; sessions: Session[] }) {
  if (tab.kind === "stub") {
    return <StubIcon stub={tab.stub} className="size-3.5 shrink-0 text-text-muted" />;
  }
  if (tab.kind === "file") {
    return <FileTypeIcon name={tab.relative} className="size-3.5" />;
  }
  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) return null;
  return session.kind === "agent" ? (
    <RobotIcon className="size-3.5 shrink-0 text-text-muted" />
  ) : (
    <ProviderIcon provider={session.provider} className="size-3.5" />
  );
}
