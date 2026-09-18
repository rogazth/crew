import { CURSOR_STYLES, MONO_FONTS, type CursorStyle } from "@crew/fixtures";
import type { TerminalPrefs } from "@/lib/prefs";
import { Card, IconButton, Row, Segmented, Select, type SegmentedOption, type SelectOption } from "@/ui";
import { store, useApp } from "@/lib/store";

const MIN = 9;
const MAX = 22;

const FONTS: Array<SelectOption<string>> = MONO_FONTS.map((font) => ({ id: font, label: font }));

const CURSORS: Array<SegmentedOption<CursorStyle>> = CURSOR_STYLES.map((style) => ({
  id: style,
  label: <span className="font-mono text-sm">{style}</span>,
}));

export function TerminalSettings() {
  const terminal = useApp().terminal;

  return (
    <>
      <Card title="Type">
        <Row
          label="Font family"
          description="The face every terminal in the window renders with. Anything missing from the system falls back to ui-monospace."
          control={
            <Select
              value={terminal.fontFamily}
              options={FONTS}
              onChange={(next) => store.setTerminal({ fontFamily: next })}
              label="Terminal font"
              shape="chip"
              className="font-mono"
            />
          }
        />
        <Row
          label="Font size"
          description="Half-point steps between 9 and 22. ⌘= and ⌘− move it from inside a terminal too."
          control={<SizeStepper size={terminal.fontSize} />}
        />
        <Row
          label="Cursor"
          description="The shape of the caret where the shell is waiting for you."
          control={
            <Segmented
              value={terminal.cursorStyle}
              options={CURSORS}
              onChange={(next) => store.setTerminal({ cursorStyle: next })}
              label="Cursor style"
            />
          }
        />
      </Card>

      <Card title="Preview">
        <Row
          stacked
          label="Live"
          description="The real terminal surface reads these the moment they change."
          control={<TerminalPreview terminal={terminal} />}
        />
      </Card>
    </>
  );
}

function SizeStepper({ size }: { size: number }) {
  const step = (delta: number) =>
    store.setTerminal({ fontSize: Math.min(MAX, Math.max(MIN, Math.round((size + delta) * 2) / 2)) });
  return (
    <div className="flex items-center gap-1">
      <IconButton label="Smaller" variant="default" disabled={size <= MIN} onClick={() => step(-0.5)}>
        <span className="font-mono text-sm" aria-hidden>
          −
        </span>
      </IconButton>
      <span className="w-[5ch] text-center font-mono text-sm text-ink">{size.toFixed(1)}</span>
      <IconButton label="Larger" variant="default" disabled={size >= MAX} onClick={() => step(0.5)}>
        <span className="font-mono text-sm" aria-hidden>
          +
        </span>
      </IconButton>
    </div>
  );
}

type Line = { prompt?: boolean; text: string; tone?: "ok" | "warn" | "error" | "dim" };

const LINES: Line[] = [
  { prompt: true, text: "cargo build -p crew-core" },
  { text: "   Compiling crew-core v0.1.0", tone: "dim" },
  { text: "    Finished dev [unoptimized] in 4.21s", tone: "ok" },
  { prompt: true, text: "pnpm -C renderer test --run" },
  { text: " ✓ src/lib/tabs.test.ts  (12 tests)", tone: "ok" },
  { text: " ✗ src/lib/route.test.ts (1 failed)", tone: "error" },
];

const TONE: Record<NonNullable<Line["tone"]>, string> = {
  ok: "text-green-ink",
  warn: "text-amber-ink",
  error: "text-red-ink",
  dim: "text-ink-3",
};

function TerminalPreview({ terminal }: { terminal: TerminalPrefs }) {
  return (
    <div
      className="overflow-hidden rounded-[var(--r)] border border-rule bg-sunken px-3 py-2"
      style={{
        fontFamily: `"${terminal.fontFamily}", var(--font-mono)`,
        fontSize: terminal.fontSize,
        lineHeight: 1.5,
      }}
    >
      {LINES.map((line, at) => (
        <div key={at} className="whitespace-pre text-ink-2">
          {line.prompt ? (
            <>
              <span className="text-green-ink">~/crew</span>{" "}
              <span className="text-accent-ink">❯</span>{" "}
            </>
          ) : null}
          <span className={line.tone ? TONE[line.tone] : undefined}>{line.text}</span>
        </div>
      ))}
      <div className="whitespace-pre text-ink-2">
        <span className="text-green-ink">~/crew</span> <span className="text-accent-ink">❯</span>{" "}
        <Caret style={terminal.cursorStyle} />
      </div>
    </div>
  );
}

function Caret({ style }: { style: CursorStyle }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: style === "bar" ? "2px" : "0.6em",
        height: style === "underline" ? "2px" : "1.05em",
        background: "currentColor",
        verticalAlign: style === "underline" ? "0" : "-0.18em",
        animation: "blink 1.06s steps(1, end) infinite",
      }}
    />
  );
}
