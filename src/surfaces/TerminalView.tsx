import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTerminalPrefs } from "../hooks/useTerminalPrefs";
import * as api from "../lib/api";
import { subscribePty } from "../lib/pty";
import { fontStack, ligaturesEnabled } from "../lib/terminalPrefs";
import {
  ANSI_DARK,
  ANSI_LIGHT,
  isOscColorQuery,
  oscColorReply,
  rgbToHex,
} from "../lib/terminalColors";
import "@xterm/xterm/css/xterm.css";

type Props = {
  id: string;
  cwd: string;
  /** Empty spawns the login shell. */
  command: string[];
  active: boolean;
  onExit?: ((code: number | null) => void) | undefined;
};

const DARK_SCHEME = window.matchMedia("(prefers-color-scheme: dark)");

function cssColor(expr: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = expr;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return rgbToHex(color || fallback);
}

/** The terminal is the canvas: same background, same text colour, ANSI tuned to it. */
function palette() {
  const dark = DARK_SCHEME.matches;
  const background = cssColor("var(--color-canvas)", dark ? "#1a1a1a" : "#ffffff");
  const foreground = cssColor("var(--color-text)", dark ? "#e8eef2" : "#2e2e2e");
  return {
    background,
    foreground,
    cursor: cssColor("var(--color-accent)", foreground),
    cursorAccent: background,
    selectionBackground: dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)",
    selectionInactiveBackground: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.07)",
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

export function TerminalView({ id, cwd, command, active, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const ligaturesRef = useRef<LigaturesAddon | null>(null);
  const { prefs } = useTerminalPrefs();
  const onExitRef = useRef(onExit);
  const commandRef = useRef(command);
  useEffect(() => {
    onExitRef.current = onExit;
    // Only read at spawn; a later argv must not respawn the running process.
    commandRef.current = command;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let colors = palette();
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      smoothScrollDuration: 0,
      macOptionIsMeta: true,
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
    termRef.current = term;

    let closed = false;
    let spawned = false;
    let lastCols = 0;
    let lastRows = 0;

    // Meta combos are the app's hotkeys; the browser must see them. Cmd+V is
    // handled by the paste listener below, Cmd+C by the copy one.
    term.attachCustomKeyEventHandler((event) => {
      if (!event.metaKey || event.ctrlKey) return true;
      if (event.key === "a" && event.type === "keydown") term.selectAll();
      return false;
    });

    const onCopy = (event: ClipboardEvent) => {
      const text = term.getSelection();
      if (!text) return;
      event.clipboardData?.setData("text/plain", text);
      event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      term.paste(text);
    };
    host.addEventListener("copy", onCopy);
    host.addEventListener("paste", onPaste);

    const unsubscribe = subscribePty(
      id,
      (bytes) => term.write(bytes),
      (code) => {
        if (closed) return;
        spawned = false;
        term.writeln(`\r\n\x1b[2m[process exited${code == null ? "" : ` (${code})`}]\x1b[0m`);
        onExitRef.current?.(code);
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
    ];

    const input = term.onData((data) => {
      if (spawned) void api.writePty(id, data);
    });

    const applySize = () => {
      if (closed || host.clientWidth < 8 || host.clientHeight < 8) return;
      fit.fit();
      const { cols, rows } = term;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      if (spawned) {
        void api.resizePty(id, cols, rows);
        return;
      }
      spawned = true;
      void api.spawnPty(id, cwd, commandRef.current, cols, rows).catch((error: unknown) => {
        spawned = false;
        term.writeln(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
      });
    };
    fitRef.current = applySize;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applySize();
      });
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
      observer.disconnect();
      DARK_SCHEME.removeEventListener("change", onScheme);
      host.removeEventListener("copy", onCopy);
      host.removeEventListener("paste", onPaste);
      input.dispose();
      for (const handler of osc) handler.dispose();
      unsubscribe();
      void api.killPty(id);
      term.dispose();
      ligaturesRef.current = null;
      termRef.current = null;
      fitRef.current = () => {};
    };
  }, [id, cwd]);

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

  useEffect(() => {
    if (!active) return;
    fitRef.current();
    termRef.current?.focus();
  }, [active]);

  return (
    <div className="crew-terminal h-full min-h-0 w-full min-w-0 bg-canvas p-3">
      <div ref={hostRef} className="h-full min-h-0 w-full min-w-0 overflow-hidden" />
    </div>
  );
}
