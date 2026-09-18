import { useEffect } from "react";
import { STUB_LABELS } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { useGlobalCommands } from "@/lib/commands";
import { AppProvider, useApp } from "@/lib/store";
import { AgentSheet } from "@/chrome/AgentSheet";
import { CommandPalette } from "@/chrome/CommandPalette";
import { ConfirmDialog } from "@/chrome/ConfirmDialog";
import { Sidebar } from "@/chrome/Sidebar";
import { TabBar } from "@/chrome/TabBar";
import { Chat } from "@/surfaces/chat/Chat";
import { FileEditor } from "@/surfaces/FileEditor";
import { Routines } from "@/surfaces/Routines";
import { Search } from "@/surfaces/Search";
import { Settings } from "@/surfaces/Settings";
import { Terminal } from "@/surfaces/Terminal";
import { Empty, TooltipProvider } from "@/ui";

export function App() {
  return (
    <AppProvider>
      <TooltipProvider>
        <Shell />
      </TooltipProvider>
    </AppProvider>
  );
}

function Shell() {
  useGlobalCommands();
  const { sidebarCollapsed } = useApp();

  return (
    <div className="flex h-full w-full overflow-hidden bg-recessed">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* The traffic lights live over the sidebar; when it is gone the reserve
            moves to the strip, which is why both own the same inset token. */}
        {!sidebarCollapsed && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 h-10 w-0"
            style={{ width: 0 }}
          />
        )}
        <TabBar />
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-tl-card bg-canvas hairline-soft">
          <Tabs />
          <Page />
        </div>
      </main>
      <CommandPalette />
      <AgentSheet />
      <ConfirmDialog />
    </div>
  );
}

/**
 * Tabs stay mounted underneath a page, so leaving Settings puts the reader back
 * exactly where they were — same scroll, same folded phases, same draft.
 */
function Tabs() {
  const { tabs, sessions, page } = useApp();
  return (
    <div className={cx("absolute inset-0", page && "pointer-events-none")} aria-hidden={Boolean(page)}>
      {tabs.tabs.length === 0 && !page && (
        <Empty
          icon="layers"
          title="No tabs open"
          description="Pick a session on the left, or press ⌘T."
          className="h-full"
        />
      )}
      {tabs.tabs.map((tab) => {
        const active = tab.id === tabs.activeId;
        if (!active) return null;
        if (tab.kind === "session") {
          const session = sessions.find((s) => s.id === tab.sessionId);
          if (!session) return null;
          return session.kind === "terminal" ? (
            <Terminal key={tab.id} sessionId={session.id} />
          ) : (
            <Chat key={tab.id} session={session} />
          );
        }
        if (tab.kind === "file") {
          return <FileEditor key={tab.id} relative={tab.relative} path={tab.path} />;
        }
        return <StubSurface key={tab.id} title={STUB_LABELS[tab.stub] ?? tab.title} kind={tab.stub} />;
      })}
    </div>
  );
}

function Page() {
  const { page } = useApp();
  if (!page) return null;
  return (
    <div className="absolute inset-0 z-10 bg-canvas">
      {page.kind === "settings" && <Settings />}
      {page.kind === "routines" && <Routines />}
      {page.kind === "search" && <Search />}
    </div>
  );
}

function StubSurface({ title, kind }: { title: string; kind: string }) {
  const { actions } = useApp();
  useEffect(() => {
    document.title = `Crew — ${title}`;
    return () => {
      document.title = "Crew — Ink";
    };
  }, [title]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas">
      <span className="flex size-10 items-center justify-center rounded-card bg-[var(--fill-quaternary)] text-icon-faint">
        <Icon name={kind === "browser" ? "globe" : kind === "sidechat" ? "message" : "terminal"} size={20} />
      </span>
      <p className="text-body text-secondary">{title}</p>
      <p className="max-w-80 text-center text-small text-tertiary">
        A pane the shell can host but the prototype does not implement. It exists so the tab
        strip has something other than sessions and files in it.
      </p>
      <button
        type="button"
        onClick={() => actions.openPalette("sessions")}
        className="text-small text-[var(--accent)] underline decoration-[color-mix(in_oklch,var(--accent)_40%,transparent)] underline-offset-2"
      >
        Open something real
      </button>
    </div>
  );
}
