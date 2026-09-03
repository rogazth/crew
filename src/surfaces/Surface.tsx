import { EmptyState } from "./EmptyState";
import { FileEditor } from "./FileEditor";
import { StubView } from "./StubView";
import { commandKeys } from "../lib/commands";
import type { Session, Tab } from "../lib/types";

type Props = {
  tab: Tab | null;
  sessions: Session[];
  hasWorkspace: boolean;
  onCreateWorkspace: () => void;
};

/** Routes the active tab to whatever fills the pane. Agents and terminals stay mounted in their overlays. */
export function Surface({ tab, sessions, hasWorkspace, onCreateWorkspace }: Props) {
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
    return tab.stub === "terminal" ? null : <StubView stub={tab.stub} title={tab.title} />;
  }
  if (tab.kind === "file") {
    // Keyed by path: CodeView keeps its previous item when only props change,
    // which rendered the old file's contents under the new tab's header.
    return <FileEditor key={tab.path} path={tab.path} relative={tab.relative} />;
  }

  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) return <EmptyState title="Session not found." />;
  return null;
}
