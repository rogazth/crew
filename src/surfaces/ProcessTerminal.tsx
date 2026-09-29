import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTerminalPrefs } from "../hooks/useTerminalPrefs";
import * as api from "../lib/api";
import { client } from "../lib/client";
import type { Process } from "../lib/processes";
import type { PtyResync } from "../lib/protocol";
import { parsedCount, subscribePty } from "../lib/pty";
import { openLink } from "../lib/terminalLinks";
import { fontStack } from "../lib/terminalPrefs";
import { DARK_SCHEME, palette } from "../lib/terminalTheme";
import { activateZwjUnicode } from "../lib/terminalUnicode";
import "@xterm/xterm/css/xterm.css";

const ACK_FLUSH_MS = 4;

/**
 * A process's terminal. While it runs, xterm watches its PTY: typed keys go to
 * it and the grid follows the pane. Otherwise the log's end is painted, so an
 * exited server still shows why. Closing the view never touches the process;
 * that is what makes it a process and not a terminal.
 */
export function ProcessTerminal({ process }: { process: Process }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { prefs } = useTerminalPrefs();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: "bar",
      scrollback: 10_000,
      smoothScrollDuration: 0,
      macOptionIsMeta: false,
      allowProposedApi: true,
      linkHandler: { activate: (event, uri) => openLink(uri, event) },
      theme: palette(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // DOM renderer stays.
    }
    term.loadAddon(new Unicode11Addon());
    activateZwjUnicode(term);
    term.loadAddon(new WebLinksAddon((event, uri) => openLink(uri, event)));
    termRef.current = term;
    fitRef.current = fit;
    const onScheme = () => (term.options.theme = palette());
    DARK_SCHEME.addEventListener("change", onScheme);
    return () => {
      DARK_SCHEME.removeEventListener("change", onScheme);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontStack(prefs.fontFamily);
    term.options.fontSize = prefs.fontSize;
    term.options.lineHeight = prefs.lineHeight;
    fitRef.current?.fit();
  }, [prefs]);

  const { workspaceId, id, ptyId, streamId } = process;

  // One run at a time: a restart hands the process a new stream, and the
  // screen starts over with it.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    // After whatever the last run still had queued, so none of it lands on this one.
    term.write("", () => term.reset());
    let closed = false;

    if (streamId === null) {
      void api
        .processLogTail(workspaceId, id)
        .then((tail) => !closed && term.write(tail.text))
        .catch(() => {});
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(host);
      return () => {
        closed = true;
        observer.disconnect();
      };
    }

    const parsed = parsedCount();
    let ackTimer = 0;
    const flushAck = () => {
      ackTimer = 0;
      void api.ackPty(ptyId, parsed.processed).catch(() => {});
    };
    const unsubscribe = subscribePty(
      ptyId,
      (bytes) => {
        const counted = parsed.write(bytes.length);
        term.write(bytes, () => {
          if (closed || !counted()) return;
          if (!ackTimer) ackTimer = window.setTimeout(flushAck, ACK_FLUSH_MS);
        });
      },
      // The run's end shows in the log tail painted next, with how it ended.
      () => {},
      (start) => parsed.attached(start),
    );
    // The daemon dropped frames this view had no room for; the ring has them.
    // The reset waits for what xterm has queued, or those bytes would paint
    // over the replay; the replay waits for the reset. A second resync before
    // then makes the first one's moot.
    let resyncs = 0;
    const offResync = client.on("pty-resync", (payload) => {
      if ((payload as PtyResync).id !== ptyId || closed) return;
      parsed.resync();
      const mine = ++resyncs;
      term.write("", () => {
        if (closed || mine !== resyncs) return;
        term.reset();
        void api.reattachPty(ptyId).catch(() => {});
      });
    });
    const input = term.onData((data) => void api.writePty(ptyId, data).catch(() => {}));
    let cols = 0;
    let rows = 0;
    const resize = () => {
      if (host.clientWidth < 8 || host.clientHeight < 8) return;
      fit.fit();
      if (term.cols === cols && term.rows === rows) return;
      cols = term.cols;
      rows = term.rows;
      void api.resizePty(ptyId, cols, rows).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    void api.attachPty(ptyId, streamId);

    return () => {
      closed = true;
      if (ackTimer) clearTimeout(ackTimer);
      observer.disconnect();
      offResync();
      input.dispose();
      unsubscribe();
    };
  }, [workspaceId, id, ptyId, streamId]);

  return (
    <div className="crew-terminal h-full min-h-0 w-full min-w-0 bg-canvas p-3">
      <div ref={hostRef} className="h-full min-h-0 w-full min-w-0 overflow-hidden" />
    </div>
  );
}
