import { PlugIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { mcpLogin, mcpReconnect } from "../../lib/api";
import { openUrl } from "../../lib/host";
import { actionOf, chipLabel, sortedServers, stateLabel, unreportedNote, useMcp } from "../../lib/mcp";
import { providerOf } from "../../lib/providers";
import type { McpServer } from "../../lib/protocol";
import type { Session } from "../../lib/types";
import { ServiceMark } from "../settings/integrations/mark";
import { ActionWord, StatusSegment, StatusSheet, useStatusSheet } from "./ComposerParts";
import { useChatActions } from "./context";

const failure = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** Where a known server's favicon comes from; the rest draw a monogram. */
const PUBLISHERS: Record<string, string> = { sentry: "sentry.io", linear: "linear.app", context7: "context7.com", figma: "figma.com" };
const niceName = (name: string) => name.replace(/^claude\.ai\s+/, "");
const brandOf = (name: string) => {
  const nice = niceName(name);
  return { id: nice, name: nice, publisher: PUBLISHERS[nice.toLowerCase()] ?? nice, logo: null };
};

/**
 * The status line's "Connectors", while the session has MCP servers, and the
 * sheet it opens over the composer: what is installed, with a way to sign in to
 * one that asks for it or to connect one that failed again. Switching one off
 * is the Connectors page's. The label never changes: a dot says something needs
 * the user, and the sheet says what. The composer owns whether it is open: only
 * one sheet is open at a time.
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
  const status = useMcp(session.id);
  const alarm = chipLabel(status);
  const servers = sortedServers(status);
  const shown = open && servers.length > 0;
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { box, trigger, opened } = useStatusSheet(shown, close, onEscape);
  // What a row is doing, and why its last try failed, by server.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<Readonly<Record<string, string>>>({});
  const { openSignIn, openConnectors } = useChatActions();

  const run = async (server: McpServer, work: () => Promise<void>) => {
    setBusy((now) => new Set(now).add(server.name));
    setFailed((now) => Object.fromEntries(Object.entries(now).filter(([name]) => name !== server.name)));
    try {
      await work();
    } catch (reason) {
      setFailed((now) => ({ ...now, [server.name]: failure(reason) }));
    } finally {
      setBusy((now) => {
        const next = new Set(now);
        next.delete(server.name);
        return next;
      });
    }
  };

  const signIn = (server: McpServer) =>
    run(server, async () => {
      const how = await mcpLogin(session.id, server.name);
      if (how.kind === "url") {
        await openUrl(how.url);
        return;
      }
      close();
      openSignIn(session.id, server.name, how.command);
    });
  const reconnect = (server: McpServer) => run(server, async () => void (await mcpReconnect(session.id, server.name)));

  const provider = providerOf(session.provider)?.label ?? session.provider;
  const note = unreportedNote(status, provider);
  return (
    <>
      {servers.length > 0 && (
        <StatusSegment
          ref={trigger}
          data-connectors-trigger
          icon={PlugIcon}
          label="Connectors"
          title={alarm ?? undefined}
          dot={alarm ? "warning" : undefined}
          open={shown}
          onClick={(event) => {
            opened(event);
            onOpenChange(!open);
          }}
        />
      )}
      {shown && (
        <StatusSheet
          ref={box}
          data-connectors-sheet
          title="Connectors"
          action={
            <ActionWord
              onClick={() => {
                close();
                openConnectors();
              }}
            >
              Manage
            </ActionWord>
          }
        >
          {servers.map((server) => (
            <ServerRow key={server.name} server={server} busy={busy.has(server.name)} error={failed[server.name]} onSignIn={() => void signIn(server)} onReconnect={() => void reconnect(server)} />
          ))}
          {note && <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] text-placeholder">{note}</div>}
        </StatusSheet>
      )}
    </>
  );
}

/** One server: its mark, with a dot when something is wrong, its name, and its one fix if it needs one. */
function ServerRow({ server, busy, error, onSignIn, onReconnect }: { server: McpServer; busy: boolean; error: string | undefined; onSignIn: () => void; onReconnect: () => void }) {
  const off = server.state === "disabled";
  const action = off ? null : actionOf(server);
  const dot = server.state === "failed" ? "bg-danger" : server.state === "needs_auth" ? "bg-warning" : null;
  return (
    <div data-server={server.name} title={error ?? server.error ?? undefined} className="flex h-9 min-w-0 shrink-0 items-center gap-2.5 rounded-lg px-2 text-[13px] hover:bg-hover">
      <span className="relative grid size-5 shrink-0 place-items-center">
        <ServiceMark brand={brandOf(server.name)} size={20} className={off ? "opacity-55" : ""} />
        {dot && <span className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface ${dot}`} />}
      </span>
      <span className={`min-w-0 flex-1 truncate ${off ? "text-text-muted" : ""}`}>{niceName(server.name)}</span>
      {error && <span className="max-w-[45%] truncate text-[12px] text-danger">{error}</span>}
      {action ? (
        <span className="-mr-2">
          <ActionWord disabled={busy} onClick={action === "sign-in" ? onSignIn : onReconnect}>
            {action === "sign-in" ? "Sign in" : "Retry"}
          </ActionWord>
        </span>
      ) : server.state === "connected" ? null : (
        <span className="shrink-0 text-[12px] text-text-muted">{stateLabel(server)}</span>
      )}
    </div>
  );
}
