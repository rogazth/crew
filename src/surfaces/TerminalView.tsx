import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalMenu } from "../chrome/TerminalMenu";
import { menuFromEvent, type MenuPoint } from "../lib/menu";
import { useFileDrop } from "../hooks/useFileDrop";
import { useTerminalPrefs } from "../hooks/useTerminalPrefs";
import { useTerminalSearch } from "../hooks/useTerminalSearch";
import * as api from "../lib/api";
import { subscribePty } from "../lib/pty";
import { holdTerminal } from "../lib/terminalFocus";
import { IS_MAC } from "../lib/hotkey";
import { filePathProvider, openLink } from "../lib/terminalLinks";
import { resolveTerminalKey } from "../lib/terminalKeys";
import { activateZwjUnicode } from "../lib/terminalUnicode";
import { quotePath, quotePaths } from "../lib/terminalPaths";
import { fontStack, ligaturesEnabled } from "../lib/terminalPrefs";
import { gridStep } from "../lib/terminalStart";
import { osc777Message, oscClipboardText } from "../lib/terminalClipboard";
import { isOscColorQuery, oscColorReply } from "../lib/terminalColors";
import { DARK_SCHEME, palette } from "../lib/terminalTheme";
import { FindBar } from "../chrome/FindBar";
import "@xterm/xterm/css/xterm.css";

type Props = {
  id: string;
  cwd: string;
  /** Empty spawns the login shell. */
  command: string[];
  /** The terminal session `command` runs, so the daemon can hand it Crew's tools. Not the shell it falls back to. */
  session?: string | undefined;
  active: boolean;
  onExit?: ((code: number | null) => void) | undefined;
  /** Once the process exits, fall back to the login shell instead of a dead pane. */
  shellOnExit?: boolean | undefined;
  /**
   * Unmounting lets go of the process instead of ending it: a session's CLI
   * runs on with its tab closed, and the next mount on this id attaches to it.
   * The shell that replaced an exited CLI holds nothing, and ends all the same.
   */
  detach?: boolean | undefined;
  /**
   * The daemon came back without the process and never said it ended: it
   * restarted, and took it along. Left out, that reads as an exit.
   */
  onLost?: (() => void) | undefined;
  /** The process asked for attention: a bell, or an OSC notification. */
  /** A bell, or an OSC 9 / 777 notification with what it says. */
  onBell?: ((message?: string) => void) | undefined;
  /** Output arrived. Throttled, so it reads as "this session is busy". */
  onActivity?: (() => void) | undefined;
  /** The process retitled its terminal. */
  onTitle?: ((title: string) => void) | undefined;
  /** The user sent something: a key, a paste, a click, a focus change. */
  onInput?: (() => void) | undefined;
  /** The grid changed size, which makes a TUI repaint. */
  onResize?: (() => void) | undefined;
  onOpenPath?: ((path: string) => void) | undefined;
  /**
   * Crew's chat is drawn over this terminal: it keeps running and sized, but
   * the keys and the terminal commands go to the chat.
   */
  covered?: boolean | undefined;
  /** The rows on screen, after output settles; for a view drawn over the terminal to read. */
  onScreen?: ((lines: string[]) => void) | undefined;
  /**
   * Starts the process out of sight, at xterm's own grid, before the pane is
   * shown: a session handed work, and one the user already opened and left
   * while its CLI was still coming up.
   */
  eager?: boolean | undefined;
};

const ACTIVITY_INTERVAL = 400;
const ACK_FLUSH_MS = 4;
/** How long output must pause before the screen is read again for `onScreen`. */
const SCREEN_SETTLE_MS = 250;
/** A CLI that never pauses (a spinner turning) is still read this often. */
const SCREEN_CEILING_MS = 1000;
/** Frames the proposed grid may keep changing before it is applied anyway. */
const MAX_STABILITY_FRAMES = 8;

const isDark = () => DARK_SCHEME.matches;

export function TerminalView({
  id,
  cwd,
  command,
  session,
  active,
  shellOnExit,
  detach = false,
  onExit,
  onLost,
  onBell,
  onActivity,
  onTitle,
  onInput,
  onResize,
  onOpenPath,
  covered = false,
  onScreen,
  eager = false,
}: Props) {
  const paneRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const settleScreenRef = useRef<() => void>(() => {});
  const ligaturesRef = useRef<LigaturesAddon | null>(null);
  const { prefs } = useTerminalPrefs();
  const [menu, setMenu] = useState<{ point: MenuPoint; hasSelection: boolean } | null>(null);
  const search = useTerminalSearch(termRef, isDark);
  const attachSearch = search.attach;

  const latest = useRef({ onExit, onLost, onBell, onActivity, onTitle, onInput, onResize, onOpenPath, onScreen, command, session, shellOnExit, detach, eager });
  useEffect(() => {
    // Only `command` at spawn: a later argv must not respawn the running process.
    latest.current = { onExit, onLost, onBell, onActivity, onTitle, onInput, onResize, onOpenPath, onScreen, command, session, shellOnExit, detach, eager };
  });

  const dropPaths = useCallback((paths: string[]) => {
    const term = termRef.current;
    if (!term) return;
    // Trailing space, like every native terminal: the next drop lands as its own argument.
    term.paste(`${quotePaths(paths)} `);
    term.focus();
  }, []);
  const over = useFileDrop(paneRef, dropPaths);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let colors = palette();
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      scrollSensitivity: 1.15,
      smoothScrollDuration: 0,
      // Option composes accents, as in Terminal.app; word motions are spelled out in terminalKeys.
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true },
      linkHandler: { activate: (event, uri) => openLink(uri, event) },
      theme: colors,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // The DOM renderer leaves hairlines between block glyphs, which breaks the
    // pixel art CLIs draw; WebGL rasterises those cells itself.
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
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    const detachSearch = attachSearch(searchAddon);
    termRef.current = term;

    let closed = false;
    let spawned = false;
    /**
     * The first spawn is size-driven once the pane can be measured. Out of
     * sight, a pane already revealed starts at xterm's own grid; a dead pane
     * must not resize back to life.
     */
    let gate = { started: false, revealed: latest.current.eager };
    let shellFallback = false;
    let lastCols = 0;
    let lastRows = 0;
    let lastActivity = 0;
    let processed = 0;
    let ackTimer = 0;
    // A fresh attach repaints what the process printed before this view: a
    // reopened tab replays the last turn's spinning title, its bells. That
    // already happened; reported again, it reads as the CLI working now.
    /** The stream offset just past the last byte received. */
    let received = 0;
    /** Where the ring's repaint ends; the bytes before it are history. */
    let replayEnd = 0;
    /** xterm is parsing the repaint: its titles and bells are not news. */
    let replaying = false;
    let screenTimer = 0;
    let screenDue = 0;
    // The live screen, not where the user scrolled to: what the CLI is showing now.
    const readScreen = () => {
      screenTimer = 0;
      screenDue = 0;
      const report = latest.current.onScreen;
      if (!report || closed) return;
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < term.rows; row += 1) {
        lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
      }
      report(lines);
    };
    const settleScreen = () => {
      const now = Date.now();
      if (!screenDue) screenDue = now + SCREEN_CEILING_MS;
      if (screenTimer) clearTimeout(screenTimer);
      screenTimer = window.setTimeout(readScreen, Math.min(SCREEN_SETTLE_MS, screenDue - now));
    };
    settleScreenRef.current = settleScreen;
    // xterm keeps the kitty flags private, so they are mirrored off the output stream.
    let kittyFlags = 0;

    // ⌘V reaches the paste listener below and ⌘C the copy one; the rest of the
    // ⌘ chords are the app's hotkeys, which must bubble to the document.
    term.attachCustomKeyEventHandler((event) => {
      const action = resolveTerminalKey(event, {
        isMac: IS_MAC,
        kittyKeyboard: kittyFlags !== 0,
      });
      switch (action.type) {
        case "xterm":
          return true;
        case "app":
          return false;
        case "select-all":
          term.selectAll();
          return false;
        case "scroll":
          if (action.to === "top") term.scrollToTop();
          else term.scrollToBottom();
          return false;
        case "input":
          latest.current.onInput?.();
          if (spawned) void api.writePty(id, action.data);
          event.preventDefault();
          return false;
      }
    });

    const onCopy = (event: ClipboardEvent) => {
      const text = term.getSelection();
      if (!text) return;
      event.clipboardData?.setData("text/plain", text);
      event.preventDefault();
    };
    // Text is xterm's to paste. A screenshot is not text: xterm would send an
    // empty paste, which only a CLI on this Mac can answer by reading the
    // clipboard itself. It is written to the workspace's machine and pasted as
    // a path. Captured, because xterm stops the event at its textarea.
    const onPaste = (event: ClipboardEvent) => {
      if (event.clipboardData?.getData("text/plain")) return;
      const image = [...(event.clipboardData?.files ?? [])].find((file) =>
        file.type.startsWith("image/"),
      );
      if (!image) return;
      event.preventDefault();
      event.stopPropagation();
      void api
        .writeTempFile(image)
        .then((path) => {
          term.paste(quotePath(path));
          term.focus();
        })
        .catch(() => {});
    };
    host.addEventListener("copy", onCopy);
    host.addEventListener("paste", onPaste, true);

    const flushAck = () => {
      ackTimer = 0;
      if (spawned) void api.ackPty(id, processed);
    };
    const exited = (code: number | null) => {
      if (closed) return;
      spawned = false;
      kittyFlags = 0;
      term.writeln(`\r\n\x1b[2m[process exited${code == null ? "" : ` (${code})`}]\x1b[0m`);
      latest.current.onExit?.(code);
      // The shell replaces the agent once; when the user exits that shell too,
      // the pane stays dead instead of looping a new prompt forever.
      if (!latest.current.shellOnExit || shellFallback) return;
      shellFallback = true;
      spawn([]);
    };
    const unsubscribe = subscribePty(
      id,
      (bytes) => {
        const history = received < replayEnd;
        received += bytes.length;
        const caughtUp = received >= replayEnd;
        term.write(bytes, () => {
          processed += bytes.length;
          if (caughtUp) replaying = false;
          if (!ackTimer) ackTimer = window.setTimeout(flushAck, ACK_FLUSH_MS);
          if (latest.current.onScreen) settleScreen();
        });
        if (history) return;
        const now = Date.now();
        if (now - lastActivity < ACTIVITY_INTERVAL) return;
        lastActivity = now;
        latest.current.onActivity?.();
      },
      exited,
      (start, end, fresh) => {
        processed = start;
        received = start;
        replayEnd = fresh ? end : start;
        // Queued behind what xterm has yet to parse, so the flag covers the repaint alone.
        if (replayEnd > start) term.write(new Uint8Array(0), () => (replaying = true));
      },
      () => {
        if (closed) return;
        const lost = latest.current.onLost;
        if (!lost) return exited(null);
        spawned = false;
        term.writeln(`\r\n\x1b[2m[crewd restarted, and this process went with it]\x1b[0m`);
        lost();
      },
    );

    const reply = (code: 10 | 11 | 12, hex: string) => {
      void api.writePty(id, oscColorReply(code, hex));
      return true;
    };
    const ring = (message?: string) => {
      if (!replaying) latest.current.onBell?.(message);
      return true;
    };
    const osc = [
      term.parser.registerOscHandler(10, (d) => isOscColorQuery(d) && reply(10, colors.foreground)),
      term.parser.registerOscHandler(11, (d) => isOscColorQuery(d) && reply(11, colors.background)),
      term.parser.registerOscHandler(12, (d) => isOscColorQuery(d) && reply(12, colors.cursor)),
      // OSC 9 is a notification unless it opens with `4;`, which is progress.
      term.parser.registerOscHandler(9, (d) => !d.startsWith("4;") && ring(d)),
      term.parser.registerOscHandler(777, (d) => d.startsWith("notify") && ring(osc777Message(d))),
      // What tmux or a TUI copies from its own mouse selection lands on the Mac's clipboard.
      term.parser.registerOscHandler(52, (d) => {
        const text = oscClipboardText(d);
        if (text !== null) void navigator.clipboard.writeText(text).catch(() => {});
        return true;
      }),
    ];
    const kittyParam = (params: (number | number[])[]) =>
      typeof params[0] === "number" ? params[0] : 0;
    // Returning false leaves the sequence to xterm; the handlers only observe.
    const csi = [
      term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
        kittyFlags = kittyParam(params);
        return false;
      }),
      term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
        kittyFlags = kittyParam(params);
        return false;
      }),
      term.parser.registerCsiHandler({ prefix: "<", final: "u" }, () => {
        kittyFlags = 0;
        return false;
      }),
    ];
    const bell = term.onBell(() => {
      if (!replaying) latest.current.onBell?.();
    });
    const title = term.onTitleChange((next) => {
      if (!replaying) latest.current.onTitle?.(next);
    });
    const links = term.registerLinkProvider(
      filePathProvider(term, cwd, (path) => latest.current.onOpenPath?.(path)),
    );
    const input = term.onData((data) => {
      latest.current.onInput?.();
      if (spawned) void api.writePty(id, data);
    });

    // The first spawn reuses a process the daemon still runs under this id, so
    // a window opening again (an update, a relaunch) finds the agent it left.
    const spawn = (command: string[], session?: string, reuse = false) => {
      spawned = true;
      void api.spawnPty(id, cwd, command, term.cols, term.rows, { ...(session === undefined ? {} : { session }), reuse, dark: isDark() }).catch((error: unknown) => {
        spawned = false;
        term.writeln(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
      });
    };

    const measurable = () => host.clientWidth >= 8 && host.clientHeight >= 8;
    // `hidden` on an ancestor is display:none, so the box is gone. A pane still
    // in layout can measure 0 for a frame; that one waits, it does not start early.
    const onScreen = () => host.offsetParent !== null;
    const applySize = () => {
      if (closed || !measurable()) return;
      fit.fit();
      const { cols, rows } = term;
      // The first spawn must not ride on a size change: a pane that measures the
      // same twice would never start, and its later kill would find nothing.
      if (!gate.started) {
        gate = { ...gate, started: true };
        lastCols = cols;
        lastRows = rows;
        spawn(latest.current.command, latest.current.session, true);
        return;
      }
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      latest.current.onResize?.();
      void api.resizePty(id, cols, rows);
    };
    fitRef.current = applySize;

    const propose = () => {
      try {
        return fit.proposeDimensions() ?? null;
      } catch {
        return null;
      }
    };
    // The grid is applied once two frames agree on it (or it already matches),
    // so a scrollbar wobble mid-resize does not turn into a SIGWINCH loop that
    // makes full-screen TUIs repaint and shake.
    let raf = 0;
    const begin = () => {
      lastCols = term.cols;
      lastRows = term.rows;
      spawn(latest.current.command, latest.current.session, true);
    };
    const schedule = () => {
      if (raf) return;
      let previous = propose();
      let frames = 0;
      const tick = () => {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (closed) return;
          const step = gridStep(gate, onScreen());
          gate = step.gate;
          // Hidden, and never shown: wait for a resize. Hidden after the user
          // had it up: start now, at this grid, and fit it when they return.
          if (step.step === "wait") return;
          if (step.step === "start") {
            begin();
            return;
          }
          const next = propose();
          frames += 1;
          const settled =
            !next ||
            (next.cols === term.cols && next.rows === term.rows) ||
            (previous?.cols === next.cols && previous?.rows === next.rows) ||
            frames >= MAX_STABILITY_FRAMES;
          if (settled) {
            applySize();
            return;
          }
          previous = next;
          tick();
        });
      };
      tick();
    };
    // No grid to measure while it is hidden. Asked to start anyway, it does,
    // before the first frame; the look that finds it shown fits that grid.
    const opening = gridStep(gate, onScreen());
    gate = opening.gate;
    if (opening.step === "start") begin();
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    schedule();

    const onScheme = () => {
      colors = palette();
      term.options.theme = colors;
    };
    DARK_SCHEME.addEventListener("change", onScheme);

    return () => {
      closed = true;
      if (raf) cancelAnimationFrame(raf);
      if (ackTimer) clearTimeout(ackTimer);
      if (screenTimer) clearTimeout(screenTimer);
      observer.disconnect();
      DARK_SCHEME.removeEventListener("change", onScheme);
      host.removeEventListener("copy", onCopy);
      host.removeEventListener("paste", onPaste, true);
      input.dispose();
      bell.dispose();
      title.dispose();
      links.dispose();
      detachSearch();
      for (const handler of osc) handler.dispose();
      for (const handler of csi) handler.dispose();
      unsubscribe();
      if (gate.started && latest.current.detach && !shellFallback) void api.detachPty(id).catch(() => {});
      else if (gate.started) void api.killPty(id);
      term.dispose();
      ligaturesRef.current = null;
      termRef.current = null;
      fitRef.current = () => {};
      settleScreenRef.current = () => {};
    };
  }, [attachSearch, cwd, id]);

  // A reader that arrives over a screen already drawn gets it without waiting for output.
  const reads = onScreen !== undefined;
  useEffect(() => {
    if (reads) settleScreenRef.current();
  }, [reads]);

  // Runs after the mount effect, so the first spawn already measures the real font.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontStack(prefs.fontFamily);
    term.options.fontSize = prefs.fontSize;
    term.options.fontWeight = prefs.fontWeight;
    term.options.fontWeightBold = prefs.fontWeightBold;
    term.options.lineHeight = prefs.lineHeight;
    const wantLigatures = ligaturesEnabled(prefs);
    if (wantLigatures && !ligaturesRef.current) {
      const addon = new LigaturesAddon();
      term.loadAddon(addon);
      ligaturesRef.current = addon;
    } else if (!wantLigatures && ligaturesRef.current) {
      ligaturesRef.current.dispose();
      ligaturesRef.current = null;
    }
    fitRef.current();
  }, [prefs]);

  const clear = useCallback(() => termRef.current?.clear(), []);

  const copySelection = useCallback(() => {
    const text = termRef.current?.getSelection();
    if (text) void navigator.clipboard.writeText(text).catch(() => {});
  }, []);

  const pasteClipboard = useCallback(() => {
    void navigator.clipboard
      .readText()
      .then((text) => text && termRef.current?.paste(text))
      .catch(() => {});
  }, []);

  const startFind = search.start;
  useEffect(() => {
    if (!active) return;
    fitRef.current();
    if (covered) return;
    termRef.current?.focus();
    // A page such as Settings hides the whole workspace; when it goes, the keys come back here.
    const host = hostRef.current;
    let shown = (host?.clientHeight ?? 0) > 0;
    const observer = new ResizeObserver(() => {
      const now = (host?.clientHeight ?? 0) > 0;
      if (now && !shown && (document.activeElement === document.body || document.activeElement === null)) {
        termRef.current?.focus();
      }
      shown = now;
    });
    if (host) observer.observe(host);
    const release = holdTerminal({ find: startFind });
    return () => {
      observer.disconnect();
      release();
    };
  }, [active, covered, startFind]);

  return (
    <div
      ref={paneRef}
      onContextMenu={(event) => {
        if (!hostRef.current?.contains(event.target as Node)) return;
        setMenu({
          point: menuFromEvent(event),
          hasSelection: termRef.current?.hasSelection() ?? false,
        });
      }}
      className={`crew-terminal relative h-full min-h-0 w-full min-w-0 bg-canvas p-3 ${
        over ? "ring-2 ring-accent ring-inset" : ""
      }`}
    >
      <div ref={hostRef} className="h-full min-h-0 w-full min-w-0 overflow-hidden" />

      {search.open && (
        <FindBar
          label="Find in terminal"
          query={search.query}
          results={search.results}
          focusToken={search.open.token}
          onQuery={search.setQuery}
          onStep={search.step}
          onClose={search.close}
        />
      )}

      {menu && (
        <TerminalMenu
          point={menu.point}
          hasSelection={menu.hasSelection}
          onCopy={copySelection}
          onPaste={pasteClipboard}
          onSelectAll={() => termRef.current?.selectAll()}
          onClear={clear}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
