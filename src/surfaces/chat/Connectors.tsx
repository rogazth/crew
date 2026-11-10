import { PlugIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { activeServers, chipLabel, stateLabel } from "../../lib/mcp";
import type { McpServer } from "../../lib/protocol";
import { scrollShadow } from "../../lib/scrollShadow";
import type { Session } from "../../lib/types";
import { brandOfName, serverLabel } from "../settings/integrations/brand";
import { ServiceMark } from "../settings/integrations/mark";
import { ActionWord, StatusSegment, StatusSheet, useStatusSheet } from "./ComposerParts";
import { useChatActions } from "./context";
import { useSessionServers } from "./useSessionServers";

/**
 * The status line's "Connectors", and the sheet it opens over the composer: a
 * list to read of the session's MCP servers (known before its CLI runs, from what
 * that CLI has on the machine), and in its header the way to the Connectors page,
 * which is where anything is done about them. With none, it goes straight to that
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
    openConnectors(session.id);
  };

  return (
    <>
      <StatusSegment
        ref={trigger}
        data-connectors-trigger
        // Settings has a Connectors too; this one is what this session has.
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
        <StatusSheet ref={box} data-connectors-sheet title="Connectors" action={<ActionWord plain onClick={manage}>Manage</ActionWord>}>
          <ServerList servers={servers} />
        </StatusSheet>
      )}
    </>
  );
}

/**
 * The servers as pills in reading order, wrapped to the sheet. Past a few lines it
 * scrolls, fading at an edge with more beyond it as the transcript does; how many
 * fit a line moves that edge, so a resize measures too.
 */
function ServerList({ servers }: { servers: McpServer[] }) {
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    if (list.current) scrollShadow(list.current);
  }, [servers.length]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const observer = new ResizeObserver(() => scrollShadow(el));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <ul
      ref={list}
      data-connectors-list
      onScroll={(event) => scrollShadow(event.currentTarget)}
      className="crew-scroll-shadow flex max-h-[168px] flex-wrap content-start gap-1.5 overflow-y-auto overscroll-contain px-2 py-1"
    >
      {servers.map((server) => (
        <ServerItem key={server.name} server={server} />
      ))}
    </ul>
  );
}

/** One server, as wide as its name, to read and not to press: a dot when it needs the user. How it stands, error included, is its tooltip. */
function ServerItem({ server }: { server: McpServer }) {
  const wrong = server.state === "needs_auth" || server.state === "failed";
  return (
    <li data-server={server.name} title={`${serverLabel(server.name)}: ${stateLabel(server)}`} className="inline-flex h-6 max-w-[200px] min-w-0 items-center gap-1.5 rounded-full bg-fill pr-2.5 pl-1.5 text-[12px]">
      <span className="relative shrink-0">
        <ServiceMark brand={brandOfName(server.name)} size={14} />
        {wrong && <span data-server-dot className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-warning ring-1 ring-fill" />}
      </span>
      <span className="min-w-0 truncate">{serverLabel(server.name)}</span>
    </li>
  );
}
