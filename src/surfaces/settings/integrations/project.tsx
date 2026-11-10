// "In this project": what a session's CLI needs the user for and the machine's
// list cannot name, because that list is read from the home folder and a
// project's own servers are set up in its folder (.mcp.json, or Claude's local
// scope). Only there when the page was opened from a session, whose status line
// is what sent the user here; the sign-in and the new try go through that
// session, since its CLI is the one that knows the server.
import { useState } from "react";
import { mcpLogin, mcpReconnect } from "../../../lib/api";
import { envOfSession } from "../../../lib/client/registry";
import { openUrl } from "../../../lib/host";
import { actionOf, projectProblems, stateLabel, useMcp } from "../../../lib/mcp";
import type { McpServer } from "../../../lib/protocol";
import type { Session } from "../../../lib/types";
import { Group, toast } from "../ui";
import { RowAction } from "./bits";
import { brandOfName, serverLabel } from "./brand";
import { ServiceMark } from "./mark";
import { useProviderServers } from "./providers";

export type OpenSignIn = (sessionId: string, server: string, command: string[]) => void;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function FromProject({ session, onOpenSignIn }: { session: Session; onOpenSignIn: OpenSignIn }) {
  const status = useMcp(session.id);
  const machine = useProviderServers(envOfSession(session.id));
  const listed = machine.inventory.find((one) => one.provider === session.provider)?.servers ?? [];
  // Nothing until the machine has said what it has: all of a session's servers would look like the project's.
  const servers = machine.settled ? projectProblems(status, listed) : [];
  if (servers.length === 0) return null;
  return (
    <Group title="In this project">
      {servers.map((server) => (
        <ProjectRow key={server.name} session={session} server={server} onOpenSignIn={onOpenSignIn} />
      ))}
    </Group>
  );
}

function ProjectRow({ session, server, onOpenSignIn }: { session: Session; server: McpServer; onOpenSignIn: OpenSignIn }) {
  const [busy, setBusy] = useState(false);
  const label = serverLabel(server.name);
  const run = async () => {
    setBusy(true);
    try {
      if (actionOf(server) === "reconnect") {
        await mcpReconnect(session.id, server.name);
        return;
      }
      const how = await mcpLogin(session.id, server.name);
      if (how.kind === "url") await openUrl(how.url);
      else onOpenSignIn(session.id, server.name, how.command);
    } catch (error) {
      toast(`Couldn’t reach ${label}: ${reason(error)}`, "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-project-server={server.name} title={server.error ?? undefined} className="flex h-14 items-center gap-2.5">
      <ServiceMark brand={brandOfName(server.name)} size={22} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{label}</span>
        <span className="truncate text-[12px] text-text-muted">{stateLabel(server)}</span>
      </span>
      {!busy && <RowAction label={actionOf(server) === "reconnect" ? "Try now" : "Sign in"} onClick={() => void run()} />}
    </div>
  );
}
