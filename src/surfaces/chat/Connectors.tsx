import { PlugIcon } from "lucide-react";
import { useCallback } from "react";
import { Button } from "../../chrome/kit";
import { activeServers, chipLabel, stateLabel } from "../../lib/mcp";
import type { McpServer } from "../../lib/protocol";
import type { Session } from "../../lib/types";
import { ServiceMark } from "../settings/integrations/mark";
import { StatusSegment, StatusSheet, useStatusSheet } from "./ComposerParts";
import { useChatActions } from "./context";
import { useSessionServers } from "./useSessionServers";

/** Where a known server's favicon comes from; the rest draw a monogram. */
const PUBLISHERS: Record<string, string> = { sentry: "sentry.io", linear: "linear.app", context7: "context7.com", figma: "figma.com" };
const niceName = (name: string) => name.replace(/^claude\.ai\s+/, "");
const brandOf = (name: string) => {
  const nice = niceName(name);
  return { id: nice, name: nice, publisher: PUBLISHERS[nice.toLowerCase()] ?? nice, logo: null };
};

/**
 * The status line's "Connectors", and the sheet it opens over the composer: the
 * session's MCP servers (known before its CLI runs, from what that CLI has on
 * the machine), all alike, and under them the way to the Connectors page, which
 * is where anything is done about them. With none, it goes straight to that
 * page. The label never changes: a dot says something needs the user. The
 * composer owns whether it is open: only one sheet is open at a time.
 */
export function ConnectorsSegment({
  session,
  open,
  onOpenChange,
  onEscape,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sheet was closed with Esc: the composer takes the focus back. */
  onEscape: () => void;
}) {
  const status = useSessionServers(session.id, session.provider);
  const alarm = chipLabel(status);
  const servers = activeServers(status);
  const shown = open && servers.length > 0;
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { box, trigger, opened } = useStatusSheet(shown, close, onEscape);
  const { openConnectors } = useChatActions();
  const manage = () => {
    close();
    openConnectors();
  };

  return (
    <>
      <StatusSegment
        ref={trigger}
        data-connectors-trigger
        // The rail has a Connectors too; this one is what this session has.
        aria-label="This session's connectors"
        icon={PlugIcon}
        label="Connectors"
        title={alarm ?? undefined}
        dot={alarm ? "warning" : undefined}
        open={shown}
        onClick={(event) => {
          // Nothing to show: the page, where one is added.
          if (servers.length === 0) return manage();
          opened(event);
          onOpenChange(!open);
        }}
      />
      {shown && (
        <StatusSheet ref={box} data-connectors-sheet title="Connectors">
          <div className="flex max-h-[76px] shrink-0 flex-wrap gap-x-3 gap-y-1 overflow-y-auto px-2 py-1">
            {servers.map((server) => (
              <ServerItem key={server.name} server={server} />
            ))}
          </div>
          <Button data-connectors-manage onClick={manage} className="mt-1 w-full shrink-0">
            Manage connectors
          </Button>
        </StatusSheet>
      )}
    </>
  );
}

/** One server: a small mark, with a dot when something is wrong, and its name. How it stands is its tooltip. */
function ServerItem({ server }: { server: McpServer }) {
  const dot = server.state === "failed" ? "bg-danger" : server.state === "needs_auth" ? "bg-warning" : null;
  return (
    <span data-server={server.name} title={`${niceName(server.name)}: ${stateLabel(server)}`} className="inline-flex h-5 max-w-[160px] items-center gap-1.5 text-[12px] text-text-muted">
      <span className="relative shrink-0">
        <ServiceMark brand={brandOf(server.name)} size={14} />
        {dot && <span data-server-dot className={`absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-surface ${dot}`} />}
      </span>
      <span className="min-w-0 truncate">{niceName(server.name)}</span>
    </span>
  );
}
