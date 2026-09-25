import { lazy, Suspense } from "react";
import { EmptyState } from "./EmptyState";
import { HistoryView } from "./HistoryView";
import { StubView } from "./StubView";
import type { Confirm } from "../chrome/ConfirmDialog";
import { commandKeys } from "../lib/commands";
import type { ProjectFile, Session, Tab } from "../lib/types";

/** The file editors are the heaviest chunks in the app; only a file tab pays for them. */
const FileEditor = lazy(() => import("./FileEditor").then((m) => ({ default: m.FileEditor })));

type Props = {
  tab: Tab | null;
  sessions: Session[];
  hasWorkspace: boolean;
  onCreateWorkspace: () => void;
  files: ProjectFile[];
  onOpenPath: (path: string) => void;
  /** A history entry picked: the history tab becomes the page, as a browser's does. */
  onOpenHistory: (url: string) => void;
  onConfirm: (confirm: Confirm) => void;
};

/** Routes the active tab to whatever fills the pane. Agents and terminals stay mounted in their overlays. */
export function Surface({ tab, sessions, hasWorkspace, onCreateWorkspace, files, onOpenPath, onOpenHistory, onConfirm }: Props) {
  if (!hasWorkspace) {
    return (
      <EmptyState
        title="No workspace yet."
        action={{ label: "Choose a folder", onClick: onCreateWorkspace }}
      />
    );
  }
  if (!tab) {
    return (
      <EmptyState title={`Open an agent, a session, or ${commandKeys("go-to-file")} for a file.`} />
    );
  }
  if (tab.kind === "stub") {
    if (tab.stub === "terminal") return null;
    if (tab.stub === "history") return <HistoryView onOpen={onOpenHistory} onConfirm={onConfirm} />;
    return <StubView stub={tab.stub} title={tab.title} />;
  }
  // Pages stay mounted in their own overlay, like terminals.
  if (tab.kind === "browser") return null;
  if (tab.kind === "file") {
    // Keyed by path: CodeView keeps its previous item when only props change,
    // which rendered the old file's contents under the new tab's header.
    return (
      <Suspense fallback={null}>
        <FileEditor
          key={tab.path}
          path={tab.path}
          relative={tab.relative}
          files={files}
          onOpenPath={onOpenPath}
        />
      </Suspense>
    );
  }

  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) return <EmptyState title="Session not found." />;
  return null;
}
