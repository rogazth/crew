import type { WebContents } from "electron";
import type { Page } from "./agent-tools";

/** Bounded, so a chatty page driven for an hour costs the same as one driven for a minute. */
const LOG_CAP = 500;
/**
 * Past this a command is taken as stuck. Some never answer on a guest that
 * is not being drawn, and the tab's next call would wait behind it forever.
 */
const COMMAND_MS = 15_000;
const CAPTURE_MS = 5000;

type Request = { method: string; url: string; type: string; status?: number; failed?: string };

type Session = {
  page: Page;
  console: string[];
  requests: Map<string, Request>;
  droppedConsole: number;
  droppedRequests: number;
  /** Takes the session's listeners off the debugger. */
  unhook: () => void;
};

const sessions = new WeakMap<WebContents, Session>();

function push<T>(list: T[], item: T): boolean {
  list.push(item);
  if (list.length <= LOG_CAP) return false;
  list.shift();
  return true;
}

type RemoteObject = { type?: string; value?: unknown; description?: string; unserializableValue?: string };

function describe(arg: RemoteObject): string {
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.unserializableValue ?? arg.description ?? arg.type ?? "";
}

function onMessage(session: Session, method: string, params: Record<string, unknown>): void {
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const args = (params.args as RemoteObject[] | undefined) ?? [];
      if (push(session.console, `[${String(params.type)}] ${args.map(describe).join(" ")}`)) session.droppedConsole += 1;
      break;
    }
    case "Runtime.exceptionThrown": {
      const details = params.exceptionDetails as { text?: string; exception?: RemoteObject } | undefined;
      const line = details?.exception?.description ?? details?.text ?? "Uncaught error";
      if (push(session.console, `[uncaught] ${line}`)) session.droppedConsole += 1;
      break;
    }
    case "Log.entryAdded": {
      const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;
      const where = entry?.url ? ` (${entry.url})` : "";
      if (push(session.console, `[${entry?.level ?? "log"}] ${entry?.text ?? ""}${where}`)) session.droppedConsole += 1;
      break;
    }
    case "Network.requestWillBeSent": {
      const request = params.request as { method?: string; url?: string } | undefined;
      session.requests.set(String(params.requestId), {
        method: request?.method ?? "GET",
        url: request?.url ?? "",
        type: String(params.type ?? ""),
      });
      if (session.requests.size > LOG_CAP) {
        const oldest = session.requests.keys().next().value;
        if (oldest !== undefined) session.requests.delete(oldest);
        session.droppedRequests += 1;
      }
      break;
    }
    case "Network.responseReceived": {
      const known = session.requests.get(String(params.requestId));
      const response = params.response as { status?: number } | undefined;
      if (known && response?.status !== undefined) known.status = response.status;
      break;
    }
    case "Network.loadingFailed": {
      const known = session.requests.get(String(params.requestId));
      if (known) known.failed = params.canceled ? "canceled" : String(params.errorText ?? "failed");
      break;
    }
  }
}

function networkLines(session: Session): string[] {
  const lines = [...session.requests.values()].map((r) => {
    const outcome = r.failed ? `failed: ${r.failed}` : r.status !== undefined ? String(r.status) : "pending";
    return `${r.method} ${outcome} ${r.url}${r.type ? ` (${r.type})` : ""}`;
  });
  if (session.droppedRequests > 0) lines.unshift(`… ${session.droppedRequests} older requests dropped.`);
  return lines;
}

/**
 * The guest as the tools drive it, with the debugger attached. Attaching
 * starts the console and network buffers, so what they hold is what happened
 * since an agent first touched the tab.
 */
export function cdpPage(guest: WebContents): Page {
  const existing = sessions.get(guest);
  if (existing && guest.debugger.isAttached()) return existing.page;

  if (!guest.debugger.isAttached()) {
    try {
      guest.debugger.attach("1.3");
    } catch (error) {
      if (guest.isDevToolsOpened()) throw new Error("Close DevTools on this tab, then try again.");
      throw new Error(`Could not attach to the tab: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const page: Page = {
    id: guest.id,
    send: <T>(method: string, params?: Record<string, unknown>, timeoutMs = COMMAND_MS) =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
        (guest.debugger.sendCommand(method, params) as Promise<T>).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }),
    capture: async () => {
      const image = await Promise.race([
        guest.capturePage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CAPTURE_MS)),
      ]);
      return image && !image.isEmpty() ? image.toPNG().toString("base64") : null;
    },
    url: () => guest.getURL(),
    title: () => guest.getTitle(),
    loadURL: (url) => guest.loadURL(url),
    back: () => {
      if (!guest.navigationHistory.canGoBack()) return false;
      guest.navigationHistory.goBack();
      return true;
    },
    forward: () => {
      if (!guest.navigationHistory.canGoForward()) return false;
      guest.navigationHistory.goForward();
      return true;
    },
    reload: () => guest.reload(),
    waitForLoad: (timeoutMs) =>
      new Promise<void>((resolve) => {
        if (!guest.isLoading()) return resolve();
        const done = () => {
          clearTimeout(timer);
          guest.off("did-stop-loading", done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        guest.on("did-stop-loading", done);
      }),
    navigates: (ms) =>
      new Promise<boolean>((resolve) => {
        if (guest.isLoadingMainFrame()) return resolve(true);
        const seen = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
          if (!details.isMainFrame || details.isSameDocument) return;
          finish(true);
        };
        const finish = (started: boolean) => {
          clearTimeout(timer);
          guest.off("did-start-navigation", seen);
          resolve(started);
        };
        const timer = setTimeout(() => finish(false), ms);
        guest.on("did-start-navigation", seen);
      }),
    consoleLog: () => {
      const lines = [...session.console];
      if (session.droppedConsole > 0) lines.unshift(`… ${session.droppedConsole} older messages dropped.`);
      return lines;
    },
    networkLog: () => networkLines(session),
  };
  const session: Session = {
    page,
    console: [],
    requests: new Map(),
    droppedConsole: 0,
    droppedRequests: 0,
    unhook: () => {},
  };
  sessions.set(guest, session);
  const message = (_event: unknown, method: string, params: unknown) => {
    if (sessions.get(guest) === session) onMessage(session, method, params as Record<string, unknown>);
  };
  const detached = () => {
    if (sessions.get(guest) === session) sessions.delete(guest);
    session.unhook();
  };
  session.unhook = () => {
    guest.debugger.off("message", message);
    guest.debugger.off("detach", detached);
  };
  guest.debugger.on("message", message);
  guest.debugger.on("detach", detached);
  // The buffers need these; each is cheap and only runs while an agent drives the tab.
  for (const domain of ["Runtime", "Log", "Network", "Page"]) {
    void guest.debugger.sendCommand(`${domain}.enable`).catch(() => {});
  }
  return page;
}

/** Nobody drives the tab any more: the debugger lets go, and its buffers with it. */
export function releasePage(guest: WebContents): void {
  const session = sessions.get(guest);
  if (!session) return;
  sessions.delete(guest);
  session.unhook();
  try {
    if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach();
  } catch {
    // Already gone with the guest.
  }
}
