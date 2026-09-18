import { STUB_LABELS, type Tab } from "@crew/fixtures";
import { Empty } from "@/ui";
import { useApp } from "@/lib/store";
import { Chat } from "./chat/Chat";
import { Terminal } from "./Terminal";
import { FileEditor } from "./FileEditor";
import { SettingsPage } from "./Settings";
import { RoutinesPage } from "./Routines";
import { SearchPage } from "./Search";

/**
 * Tabs stay mounted underneath a page, so opening a page and coming back keeps
 * every transcript's scroll position and every terminal's buffer.
 */
export function SurfaceStack() {
  const state = useApp();
  const tabs = state.tabsByWorkspace[state.workspaceId];
  const list = tabs?.tabs ?? [];
  const activeId = tabs?.activeId ?? null;
  const page = state.page;

  return (
    <>
      {list.length === 0 && page.kind === "none" ? (
        <Empty
          title="No tabs open"
          hint="⌘T opens the launcher, ⌘K the palette, ⌘N a new agent."
        />
      ) : null}
      {list.map((tab) => (
        <div
          key={tab.id}
          hidden={tab.id !== activeId}
          className="absolute inset-0 flex min-h-0 flex-col"
        >
          <TabSurface tab={tab} active={tab.id === activeId && page.kind === "none"} />
        </div>
      ))}
      {page.kind !== "none" ? (
        <div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-bg">
          {page.kind === "settings" ? <SettingsPage section={page.section} /> : null}
          {page.kind === "routines" ? <RoutinesPage routineId={page.routineId} /> : null}
          {page.kind === "search" ? <SearchPage query={page.query} /> : null}
        </div>
      ) : null}
    </>
  );
}

function TabSurface({ tab, active }: { tab: Tab; active: boolean }) {
  const state = useApp();
  if (tab.kind === "session") {
    const session = state.sessions.find((s) => s.id === tab.sessionId);
    if (!session) return <Empty title="That session is gone." />;
    if (session.kind === "terminal") return <Terminal session={session} active={active} />;
    return <Chat session={session} active={active} />;
  }
  if (tab.kind === "file") {
    return <FileEditor relative={tab.relative} active={active} />;
  }
  if (tab.stub === "terminal") return <Terminal session={null} active={active} />;
  return (
    <Empty
      title={`${STUB_LABELS[tab.stub] ?? tab.title} is a placeholder`}
      hint="The real surface lives outside this prototype. The tab, its bindings and its chrome are real."
    />
  );
}
