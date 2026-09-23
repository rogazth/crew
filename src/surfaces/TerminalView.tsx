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
import { filePathProvider, openExternal } from "../lib/terminalLinks";
import { resolveTerminalKey } from "../lib/terminalKeys";
import { activateZwjUnicode } from "../lib/terminalUnicode";
import { quotePath, quotePaths } from "../lib/terminalPaths";
import { fontStack, ligaturesEnabled } from "../lib/terminalPrefs";
import { isOscColorQuery, oscColorReply } from "../lib/terminalColors";
import {
  activityDue,
  applyTerminalKey,
  createAckFlow,
  exitBanner,
  gridSettled,
  isOsc777Notification,
  isOsc9Notification,
  kittyParam,
  palette as themePalette,
  pastePayload,
  proposeGrid,
  sizeStep,
  spawnErrorLine,
  type Grid,
} from "../lib/terminalView";
import { TerminalSearch } from "./TerminalSearch";
import "@xterm/xterm/css/xterm.css";

type Props = {
  id: string;
  cwd: string;
  /** Empty spawns the login shell. */
  command: string[];
  active: boolean;
  onExit?: ((code: number | null) => void) | undefined;
  /** Once the process exits, fall back to the login shell instead of a dead pane. */
  shellOnExit?: boolean | undefined;
  /** The process asked for attention: a bell, or an OSC notification. */
  onBell?: (() => void) | undefined;
  /** Output arrived. Throttled, so it reads as "this session is busy". */
  onActivity?: (() => void) | undefined;
  onOpenPath?: ((path: string) => void) | undefined;
};

const DARK_SCHEME = window.matchMedia("(prefers-color-scheme: dark)");

const isDark = () => DARK_SCHEME.matches;
const palette = () => themePalette(isDark());

export function TerminalView({
  id,
  cwd,
  command,
  active,
  shellOnExit,
  onExit,
  onBell,
  onActivity,
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

  const latest = useRef({ onExit, onBell, onActivity, onOpenPath, command, shellOnExit });
  useEffect(() => {
    // Only `command` at spawn: a later argv must not respawn the running process.
    latest.current = { onExit, onBell, onActivity, onOpenPath, command, shellOnExit };
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
      linkHandler: { activate: (_event, uri) => openExternal(uri) },
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
    term.loadAddon(new WebLinksAddon((_event, uri) => openExternal(uri)));
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    const detachSearch = attachSearch(searchAddon);
    termRef.current = term;

    let closed = false;
    let spawned = false;
    /** Only the first spawn is size-driven; a dead pane must not resize back to life. */
    let last: Grid | null = null;
    let shellFallback = false;
    let lastActivity = 0;
    // xterm keeps the kitty flags private, so they are mirrored off the output stream.
    let kittyFlags = 0;
    const write = (data: string) => {
      if (spawned) void api.writePty(id, data);
    };

    // ⌘V reaches the paste listener below and ⌘C the copy one; the rest of the
    // ⌘ chords are the app's hotkeys, which must bubble to the document.
    term.attachCustomKeyEventHandler((event) => {
      const action = resolveTerminalKey(event, {
        isMac: IS_MAC,
        hasSelection: term.hasSelection(),
        kittyKeyboard: kittyFlags !== 0,
      });
      return applyTerminalKey(action, term, event, write);
    });

    const onCopy = (event: ClipboardEvent) => {
      const text = term.getSelection();
      if (!text) return;
      event.clipboardData?.setData("text/plain", text);
      event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      const payload = pastePayload(event.clipboardData);
      if (!payload) return;
      event.preventDefault();
      if (payload.kind === "text") {
        term.paste(payload.text);
        return;
      }
      void api
        .writeTempFile(payload.file)
        .then((path) => {
          term.paste(quotePath(path));
          term.focus();
        })
        .catch(() => {});
    };
    host.addEventListener("copy", onCopy);
    host.addEventListener("paste", onPaste);

    const ack = createAckFlow((processed) => {
      if (spawned) void api.ackPty(id, processed);
    });
    const unsubscribe = subscribePty(
      id,
      (bytes) => {
        term.write(bytes, () => ack.parsed(bytes.length));
        const now = Date.now();
        if (!activityDue(now, lastActivity)) return;
        lastActivity = now;
        latest.current.onActivity?.();
      },
      (code) => {
        if (closed) return;
        spawned = false;
        kittyFlags = 0;
        term.writeln(exitBanner(code));
        latest.current.onExit?.(code);
        // The shell replaces the agent once; when the user exits that shell too,
        // the pane stays dead instead of looping a new prompt forever.
        if (!latest.current.shellOnExit || shellFallback) return;
        shellFallback = true;
        spawn([]);
      },
      (start) => ack.reset(start),
    );

    const reply = (code: 10 | 11 | 12, hex: string) => {
      void api.writePty(id, oscColorReply(code, hex));
      return true;
    };
    const ring = () => {
      latest.current.onBell?.();
      return true;
    };
    const osc = [
      term.parser.registerOscHandler(10, (d) => isOscColorQuery(d) && reply(10, colors.foreground)),
      term.parser.registerOscHandler(11, (d) => isOscColorQuery(d) && reply(11, colors.background)),
      term.parser.registerOscHandler(12, (d) => isOscColorQuery(d) && reply(12, colors.cursor)),
      term.parser.registerOscHandler(9, (d) => isOsc9Notification(d) && ring()),
      term.parser.registerOscHandler(777, (d) => isOsc777Notification(d) && ring()),
    ];
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
    const bell = term.onBell(() => latest.current.onBell?.());
    const links = term.registerLinkProvider(
      filePathProvider(term, cwd, (path) => latest.current.onOpenPath?.(path)),
    );
    const input = term.onData(write);

    const spawn = (command: string[]) => {
      spawned = true;
      void api.spawnPty(id, cwd, command, term.cols, term.rows).catch((error: unknown) => {
        spawned = false;
        term.writeln(spawnErrorLine(error));
      });
    };

    const visible = () => host.clientWidth >= 8 && host.clientHeight >= 8;
    const applySize = () => {
      if (closed || !visible()) return;
      fit.fit();
      const { cols, rows } = term;
      // The first spawn must not ride on a size change: a pane that measures the
      // same twice would never start, and its later kill would find nothing.
      const step = sizeStep(last, { cols, rows });
      if (step === "same") return;
      last = { cols, rows };
      if (step === "spawn") spawn(latest.current.command);
      else void api.resizePty(id, cols, rows);
    };
    fitRef.current = applySize;

    const propose = () => proposeGrid(fit);
    // The grid is applied once two frames agree on it (or it already matches),
    // so a scrollbar wobble mid-resize does not turn into a SIGWINCH loop that
    // makes full-screen TUIs repaint and shake.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      let previous = propose();
      let frames = 0;
      const tick = () => {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (closed || !visible()) return;
          const next = propose();
          frames += 1;
          if (gridSettled(next, { cols: term.cols, rows: term.rows }, previous, frames)) {
            applySize();
            return;
          }
          previous = next;
          tick();
        });
      };
      tick();
    };
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
      ack.cancel();
      observer.disconnect();
      DARK_SCHEME.removeEventListener("change", onScheme);
      host.removeEventListener("copy", onCopy);
      host.removeEventListener("paste", onPaste);
      input.dispose();
      bell.dispose();
      links.dispose();
      detachSearch();
      for (const handler of osc) handler.dispose();
      for (const handler of csi) handler.dispose();
      unsubscribe();
      if (last) void api.killPty(id);
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
    return holdTerminal({ find: startFind });
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
      className={`crew-terminal relative h-full min-h-0 w-full min-w-0 bg-canvas p-3 ${
        over ? "ring-2 ring-accent ring-inset" : ""
      }`}
    >
      <div ref={hostRef} className="h-full min-h-0 w-full min-w-0 overflow-hidden" />

      {search.open && (
        <TerminalSearch
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
