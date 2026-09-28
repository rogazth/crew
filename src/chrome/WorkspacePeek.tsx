import { createPortal } from "react-dom";
import { ConnectionLabel, EnvGlyph } from "./EnvBits";
import { Kbd } from "./Kbd";
import { StatusDot } from "./StatusDot";
import { useEnvLinks } from "../hooks/useEnvLinks";
import { LOCAL, envOf } from "../lib/client/registry";
import { whereOf } from "../lib/envText";
import { STATUS_ORDER, statusLabel } from "../lib/status";
import type { Session, SessionStatus, Workspace } from "../lib/types";
import { workspaceMark } from "../lib/workspaces";

/** Where the card hangs: beside the mark, its top on the mark's. */
export type WorkspacePeekAnchor = { left: number; top: number };

/**
 * A rail mark held under the pointer: which workspace it is, where its folder
 * is, and, above all for one on another machine, which machine that is, how it
 * is reached and whether it answers.
 */
export function WorkspacePeek({
  workspace,
  sessions,
  keys,
  anchor,
}: {
  workspace: Workspace;
  sessions: Session[];
  keys: string;
  anchor: WorkspacePeekAnchor;
}) {
  return createPortal(
    <div
      role="tooltip"
      data-workspace-peek={workspace.id}
      style={{ left: anchor.left, top: anchor.top }}
      className="pointer-events-none fixed z-50 flex w-[280px] flex-col gap-2.5 rounded-float bg-surface p-3 text-text shadow-float"
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-[11px] font-semibold tracking-wide text-inverse">
          {workspaceMark(workspace.name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold">{workspace.name}</span>
            {keys && <Kbd keys={keys} className="ml-auto shrink-0" />}
          </span>
          <span className="truncate text-left font-mono text-[11.5px] text-text-muted" dir="rtl">
            {/* rtl keeps the folder's own name in sight when the path is long; the mark forces it back to ltr text. */}
            {`\u200E${workspace.path}`}
          </span>
        </div>
      </div>

      <Machine workspaceId={workspace.id} />

      <Tally sessions={sessions} />
    </div>,
    document.body,
  );
}

/** The machine the workspace lives on: its name, how ssh reaches it, its OS, and whether it answers. */
function Machine({ workspaceId }: { workspaceId: string }) {
  const links = useEnvLinks();
  const env = envOf(workspaceId);
  const link = links.find((item) => item.id === env) ?? null;
  const local = env === LOCAL;
  const facts = [local ? link?.info?.hostname : link && whereOf(link), link?.info?.os].filter(Boolean) as string[];
  return (
    <div data-peek-machine={local ? "local" : "remote"} className="flex flex-col gap-1 border-t border-hairline pt-2.5 text-[12px]">
      <div className="flex items-center gap-2">
        <EnvGlyph link={link} className="size-3.5" />
        <span className="min-w-0 flex-1 truncate font-medium">{link?.name ?? (local ? "This Mac" : "Unknown machine")}</span>
        {link && !local && <ConnectionLabel link={link} />}
      </div>
      {facts.length > 0 && (
        <span className="truncate pl-5.5 text-text-muted">
          {facts.map((fact, index) => (
            <span key={fact}>
              {index > 0 && " · "}
              {index === 0 && !local ? <span className="font-mono text-[11.5px]">{fact}</span> : fact}
            </span>
          ))}
        </span>
      )}
      {link && !local && link.status === "offline" && link.error && (
        <span className="line-clamp-2 pl-5.5 text-danger">{link.error}</span>
      )}
    </div>
  );
}

/** How many sessions the workspace has, and how many of them are up to something. */
function Tally({ sessions }: { sessions: Session[] }) {
  const counts = new Map<SessionStatus, number>();
  for (const session of sessions) counts.set(session.status, (counts.get(session.status) ?? 0) + 1);
  const busy = STATUS_ORDER.filter((status) => status !== "idle" && counts.has(status));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-muted">
      <span className="tabular-nums">
        {sessions.length === 0 ? "No sessions" : `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
      </span>
      {busy.map((status) => (
        <span key={status} className="flex items-center gap-1 tabular-nums">
          <StatusDot status={status} className="size-3" />
          {counts.get(status)} {statusLabel(status).toLowerCase()}
        </span>
      ))}
    </div>
  );
}
