import { useMemo } from "react";
import { Agents } from "./Agents";
import { ChatContext, type ChatActions } from "./chat/context";
import { Surface } from "./Surface";
import { Terminals } from "./Terminals";
import type { ProviderId } from "../lib/providers";
import type { ProjectFile, Session, SessionStatus, Tab } from "../lib/types";

type Props = {
  tab: Tab | null;
  tabs: Tab[];
  sessions: Session[];
  cwd: string | null;
  hasWorkspace: boolean;
  onCreateWorkspace: () => void;
  onStatus: (id: string, status: SessionStatus) => void;
  onModel: (session: Session, provider: ProviderId, model: string) => void;
  onOpenFile: (file: ProjectFile) => void;
  files: ProjectFile[];
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
  onModel,
  onOpenFile,
  files,
}: Props) {
  const chat = useMemo<ChatActions>(
    () => ({
      openPath: (path) => {
        if (!cwd) return;
        const absolute = path.startsWith("/") ? path : `${cwd}/${path.replace(/^\.\//, "")}`;
        const relative = absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute;
        onOpenFile({ path: absolute, relative, name: relative.split("/").pop() ?? relative });
      },
      files,
    }),
    [cwd, onOpenFile, files],
  );
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
          <ChatContext value={chat}>
            <Agents
              tabs={tabs}
              activeId={tab?.id ?? null}
              sessions={sessions}
              cwd={cwd}
              onModel={onModel}
            />
          </ChatContext>
        </>
      )}
    </div>
  );
}
