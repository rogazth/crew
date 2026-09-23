import { lazy, Suspense } from "react";
import { EmptyState } from "./EmptyState";
import { StubView } from "./StubView";
import { commandKeys } from "../lib/commands";
import { surfaceRoute } from "../lib/surface";
import type { Session, Tab } from "../lib/types";

/** The diff editor and its highlighter are ~600 kB; only a file tab pays for them. */
const FileEditor = lazy(() => import("./FileEditor").then((m) => ({ default: m.FileEditor })));

type Props = {
  tab: Tab | null;
  sessions: Session[];
  hasWorkspace: boolean;
  onCreateWorkspace: () => void;
};

/** Routes the active tab to whatever fills the pane. Agents and terminals stay mounted in their overlays. */
export function Surface({ tab, sessions, hasWorkspace, onCreateWorkspace }: Props) {
  const route = surfaceRoute(tab, sessions, hasWorkspace);
  switch (route.kind) {
    case "no-workspace":
      return (
        <EmptyState
          title="No workspace yet."
          action={{ label: "Choose a folder", onClick: onCreateWorkspace }}
        />
      );
    case "no-tab":
      return (
        <EmptyState title={`Open an agent, a session, or ${commandKeys("go-to-file")} for a file.`} />
      );
    case "stub":
      return <StubView stub={route.stub} title={route.title} />;
    case "file":
      // Keyed by path: CodeView keeps its previous item when only props change,
      // which rendered the old file's contents under the new tab's header.
      return (
        <Suspense fallback={null}>
          <FileEditor key={route.path} path={route.path} relative={route.relative} />
        </Suspense>
      );
    case "missing-session":
      return <EmptyState title="Session not found." />;
    case "overlay":
      return null;
  }
}
