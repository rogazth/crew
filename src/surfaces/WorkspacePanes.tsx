import { Agents } from "./Agents";
import { Surface } from "./Surface";
import { Terminals } from "./Terminals";
import type { ProjectFile, Session, SessionStatus, Tab } from "../lib/types";

type Props = {
  tab: Tab | null;
  tabs: Tab[];
  sessions: Session[];
  cwd: string | null;
  hasWorkspace: boolean;
  onCreateWorkspace: () => void;
  onStatus: (id: string, status: SessionStatus) => void;
  onBindProvider: (id: string, providerSessionId: string) => void;
  onOpenFile: (file: ProjectFile) => void;
};

/** Active surface plus the mounted agent/terminal overlays. */
export function WorkspacePanes({
  tab,
  tabs,
  sessions,
  cwd,
  hasWorkspace,
  onCreateWorkspace,
  onStatus,
  onBindProvider,
  onOpenFile,
}: Props) {
  return (
    <div className="relative min-h-0 flex-1">
      <Surface
        tab={tab}
        sessions={sessions}
        hasWorkspace={hasWorkspace}
        onCreateWorkspace={onCreateWorkspace}
      />
      {cwd && (
        <>
          <Terminals
            tabs={tabs}
            activeId={tab?.id ?? null}
            sessions={sessions}
            cwd={cwd}
            onStatus={onStatus}
            onOpenFile={onOpenFile}
          />
          <Agents
            tabs={tabs}
            activeId={tab?.id ?? null}
            sessions={sessions}
            cwd={cwd}
            onStatus={onStatus}
            onBindProvider={onBindProvider}
          />
        </>
      )}
    </div>
  );
}
