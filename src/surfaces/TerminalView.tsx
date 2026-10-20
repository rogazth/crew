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
import { oscClipboardText } from "../lib/terminalClipboard";
import { isOscColorQuery, oscColorReply } from "../lib/terminalColors";
import { DARK_SCHEME, palette } from "../lib/terminalTheme";
import { FindBar } from "../chrome/FindBar";
import "@xterm/xterm/css/xterm.css";

type Props = {
  id: string;
  cwd: string;
  /** Empty spawns the login shell. */
  command: string[];
  /** Typed into the process once it has started, with Enter; only the first spawn. */
  initialInput?: string | undefined;
  active: boolean;
  onExit?: ((code: number | null) => void) | undefined;
  /** Once the process exits, fall back to the login shell instead of a dead pane. */
  shellOnExit?: boolean | undefined;
  onOpenPath?: ((path: string) => void) | undefined;
};

const ACK_FLUSH_MS = 4;
/** Frames the proposed grid may keep changing before it is applied anyway. */
const MAX_STABILITY_FRAMES = 8;

const isDark = () => DARK_SCHEME.matches;

export function TerminalView({
  id,
  cwd,
  command,
  initialInput,
  active,
  shellOnExit,
  onExit,
  onOpenPath,
}: Props) {
  const paneRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const ligaturesRef = useRef<LigaturesAddon | null>(null);
  const { prefs } = useTerminalPrefs();
  const [menu, setMenu] = useState<{ point: MenuPoint; hasSelection: boolean } | null>(null);
  const search = useTerminalSearch(termRef, isDark);
  const attachSearch = search.attach;

  const latest = useRef({ onExit, onOpenPath, command, shellOnExit, initialInput });
  useEffect(() => {
    // Only `command` at spawn: a later argv must not respawn the running process.
    latest.current = { onExit, onOpenPath, command, shellOnExit, initialInput };
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
    let gate = { started: false, revealed: false };
    let shellFallback = false;
    let lastCols = 0;
    let lastRows = 0;
    let processed = 0;
    let ackTimer = 0;
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
        term.write(bytes, () => {
          processed += bytes.length;
          if (!ackTimer) ackTimer = window.setTimeout(flushAck, ACK_FLUSH_MS);
        });
      },
      exited,
      (start) => {
        processed = start;
      },
    );

    const reply = (code: 10 | 11 | 12, hex: string) => {
      void api.writePty(id, oscColorReply(code, hex));
      return true;
    };
    const osc = [
      term.parser.registerOscHandler(10, (d) => isOscColorQuery(d) && reply(10, colors.foreground)),
      term.parser.registerOscHandler(11, (d) => isOscColorQuery(d) && reply(11, colors.background)),
      term.parser.registerOscHandler(12, (d) => isOscColorQuery(d) && reply(12, colors.cursor)),
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
    const links = term.registerLinkProvider(
      filePathProvider(term, cwd, (path) => latest.current.onOpenPath?.(path)),
    );
    const input = term.onData((data) => {
      if (spawned) void api.writePty(id, data);
    });

    // The first spawn reuses a process the daemon still runs under this id, so
    // a window opening again (a reload, an update) finds the terminal it left.
    const spawn = (command: string[], reuse = false) => {
      spawned = true;
      const typed = latest.current.initialInput;
      latest.current.initialInput = undefined;
      void api
        .spawnPty(id, cwd, command, term.cols, term.rows, { reuse, dark: isDark() })
        .then(() => {
          // The shell reads its input once it is up; what is typed before its prompt waits in the tty.
          if (typed && !closed) void api.writePty(id, `${typed}\r`);
        })
        .catch((error: unknown) => {
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
        spawn(latest.current.command, true);
        return;
      }
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
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
      spawn(latest.current.command, true);
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
      observer.disconnect();
      DARK_SCHEME.removeEventListener("change", onScheme);
      host.removeEventListener("copy", onCopy);
      host.removeEventListener("paste", onPaste, true);
      input.dispose();
      links.dispose();
      detachSearch();
      for (const handler of osc) handler.dispose();
      for (const handler of csi) handler.dispose();
      unsubscribe();
      if (gate.started) void api.killPty(id);
      term.dispose();
      ligaturesRef.current = null;
      termRef.current = null;
      fitRef.current = () => {};
    };
  }, [attachSearch, cwd, id]);

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
  }, [active, startFind]);

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
      data-file-drop={over || undefined}
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
