import { lazy, Suspense, type ReactNode } from "react";
import { EmptyState } from "./EmptyState";
import { HistoryView } from "./HistoryView";
import { StubView } from "./StubView";
import type { Confirm } from "../chrome/ConfirmDialog";
import { commandKeys } from "../lib/commands";
import type { ProjectFile, Session, Tab } from "../lib/types";

export type ProcessTabOf = Extract<Tab, { kind: "process" }>;

/** The file editors are the heaviest chunks in the app; only a file tab pays for them. */
const FileView = lazy(() => import("./FileView").then((m) => ({ default: m.FileView })));

type Props = {
  tab: Tab | null;
  /** What shows with no tab open, in place of the hint to open one. */
  empty?: ReactNode;
  sessions: Session[];
  hasWorkspace: boolean;
  onCreateWorkspace: () => void;
  files: ProjectFile[];
  onOpenPath: (path: string) => void;
  /** An HTML or SVG file rendered in a page tab. */
  onOpenInBrowser: (file: { path: string; relative: string }) => void;
  /** A history entry picked: the history tab becomes the page, as a browser's does. */
  onOpenHistory: (url: string) => void;
  onConfirm: (confirm: Confirm) => void;
  /** What a command's tab shows: the shell holds the commands, not the panes. */
  renderProcess: (tab: ProcessTabOf) => ReactNode;
  /** The workspace's commands, in a tab of the strip they were opened from. */
  renderCommands: () => ReactNode;
};

/** Routes the active tab to whatever fills the pane. Turn chats and terminals stay mounted in their overlays. */
export function Surface({
  tab,
  empty,
  sessions,
  hasWorkspace,
  onCreateWorkspace,
  files,
  onOpenPath,
  onOpenInBrowser,
  onOpenHistory,
  onConfirm,
  renderProcess,
  renderCommands,
}: Props) {
  if (!hasWorkspace) {
    return (
      <EmptyState
        title="No workspace yet."
        action={{ label: "Choose a folder", onClick: onCreateWorkspace }}
      />
    );
  }
  if (!tab) {
    if (empty) return empty;
    return (
      <EmptyState title={`Open a bot, a session, or ${commandKeys("go-to-file")} for a file.`} />
    );
  }
  if (tab.kind === "stub") {
    if (tab.stub === "terminal") return null;
    if (tab.stub === "history") return <HistoryView onOpen={onOpenHistory} onConfirm={onConfirm} />;
    if (tab.stub === "commands") return renderCommands();
    return <StubView stub={tab.stub} title={tab.title} />;
  }
  // Mounted only while on screen: a command runs on in the daemon, and its
  // terminal paints again from the log when the tab comes back.
  if (tab.kind === "process") return renderProcess(tab);
  // Pages stay mounted in their own overlay, like terminals: a file's too.
  if (tab.kind === "browser") return null;
  if (tab.kind === "file") {
    // Keyed by path: CodeView keeps its previous item when only props change,
    // which rendered the old file's contents under the new tab's header.
    return (
      <Suspense fallback={null}>
        <FileView
          key={tab.path}
          path={tab.path}
          relative={tab.relative}
          files={files}
          onOpenPath={onOpenPath}
          onOpenInBrowser={onOpenInBrowser}
        />
      </Suspense>
    );
  }

  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) return <EmptyState title="Session not found." />;
  return null;
}
