import { useEffect, useRef, useState } from "react";
import { mcpLogin, mcpReconnect } from "../../lib/api";
import { openUrl } from "../../lib/host";
import { actionOf, chipLabel, sortedServers, stateLabel, unreportedNote, useMcp } from "../../lib/mcp";
import { providerOf } from "../../lib/providers";
import type { McpServer } from "../../lib/protocol";
import type { Session } from "../../lib/types";
import { useChatActions } from "./context";

const failure = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/**
 * The status line's "N need sign-in" or "N failed", and the sheet it opens
 * over the composer: each MCP server with how it stands, and a way to sign in
 * to one that asks for it or to connect one that failed again. Nothing is
 * drawn while every server works, or connects. A click outside the sheet
 * closes it. The composer owns whether it is open: only one sheet is open at
 * a time.
 */
export function McpSegment({
  session,
  open,
  onOpenChange,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const status = useMcp(session.id);
  const label = chipLabel(status);
  const servers = sortedServers(status);
  const shown = open && servers.length > 0;
  const sheet = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // What a row is doing, and why its last try failed, by server.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<Readonly<Record<string, string>>>({});
  const { openSignIn } = useChatActions();

  useEffect(() => {
    if (!shown) return;
    const down = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sheet.current?.contains(target) || trigger.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [shown, onOpenChange]);

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
      onOpenChange(false);
      openSignIn(session.id, server.name, how.command);
    });
  const reconnect = (server: McpServer) => run(server, async () => void (await mcpReconnect(session.id, server.name)));

  const provider = providerOf(session.provider)?.label ?? session.provider;
  const note = unreportedNote(status, provider);
  return (
    <>
      {label && (
        <button
          ref={trigger}
          type="button"
          aria-expanded={shown}
          onClick={() => onOpenChange(!open)}
          className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <span className="size-1.5 rounded-full bg-warning" aria-hidden />
          {label}
        </button>
      )}
      {shown && (
        <div
          ref={sheet}
          data-mcp-sheet
          className="absolute inset-x-6 bottom-full z-10 mb-2 flex max-h-[min(60vh,460px)] flex-col overflow-y-auto overscroll-contain rounded-2xl bg-surface p-1.5 shadow-float ring-1 ring-border"
        >
          <div className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">MCP servers</div>
          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              busy={busy.has(server.name)}
              error={failed[server.name]}
              onSignIn={() => void signIn(server)}
              onReconnect={() => void reconnect(server)}
            />
          ))}
          {note && <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] text-placeholder">{note}</div>}
        </div>
      )}
    </>
  );
}

/** One server: its name, how it stands, and the one thing that can be done about it. */
function ServerRow({
  server,
  busy,
  error,
  onSignIn,
  onReconnect,
}: {
  server: McpServer;
  busy: boolean;
  error: string | undefined;
  onSignIn: () => void;
  onReconnect: () => void;
}) {
  const action = actionOf(server);
  const tone = server.state === "failed" ? "text-danger" : server.state === "needs_auth" ? "text-warning" : "text-text-muted";
  return (
    <div data-server={server.name} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px]">{server.name}</span>
        <span title={stateLabel(server)} className={`truncate text-[11px] ${tone}`}>
          {stateLabel(server)}
        </span>
        {error && <span className="text-[11px] text-danger">{error}</span>}
      </div>
      {action && (
        <button
          type="button"
          disabled={busy}
          onClick={action === "sign-in" ? onSignIn : onReconnect}
          className="flex h-6 shrink-0 items-center rounded-md px-2 text-[11.5px] text-text-muted ring-1 ring-hairline hover:bg-selected hover:text-text disabled:opacity-50"
        >
          {action === "sign-in" ? "Sign in" : "Reconnect"}
        </button>
      )}
    </div>
  );
}
