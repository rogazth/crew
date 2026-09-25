import { ArrowCounterClockwiseIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { IconButton, Select, type Option } from "../chrome/kit";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useTerminalPrefs } from "../hooks/useTerminalPrefs";
import { installedMonoFonts } from "../lib/fonts";
import {
  clamp,
  DEFAULT_TERMINAL_PREFS,
  LIMITS,
  ligaturesEnabled,
  type Ligatures,
  type TerminalPrefs,
} from "../lib/terminalPrefs";

const LIGATURES: Option<Ligatures>[] = [
  { value: "auto", label: "Auto" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

export function TerminalSettings() {
  const { prefs, update } = useTerminalPrefs();
  const fonts = useMemo(() => installedMonoFonts(), []);
  const set = <K extends keyof TerminalPrefs>(key: K, value: TerminalPrefs[K]) =>
    update({ ...prefs, [key]: value });

  const stepper = (
    key: "fontSize" | "fontWeight" | "fontWeightBold" | "lineHeight",
    label: string,
    limits: { min: number; max: number },
    step = 1,
  ) => (
    <>
      <Reset
        hidden={prefs[key] === DEFAULT_TERMINAL_PREFS[key]}
        onClick={() => set(key, DEFAULT_TERMINAL_PREFS[key])}
      />
      <Stepper
        key={prefs[key]}
        label={label}
        value={prefs[key]}
        limits={limits}
        step={step}
        onCommit={(value) => set(key, value)}
      />
    </>
  );

  const autoNote = ligaturesEnabled({ ...prefs, ligatures: "auto" })
    ? `Auto turns them on for "${prefs.fontFamily}".`
    : `Auto leaves them off for "${prefs.fontFamily}".`;

  return (
    <>
      <SettingsSection title="Typography">
        <SettingsRow label="Font size" description="Size of terminal text, in pixels.">
          {stepper("fontSize", "Font size", LIMITS.fontSize)}
        </SettingsRow>
        <SettingsRow label="Font family" description="Monospace font for every terminal.">
          <Reset
            hidden={prefs.fontFamily === DEFAULT_TERMINAL_PREFS.fontFamily}
            onClick={() => set("fontFamily", DEFAULT_TERMINAL_PREFS.fontFamily)}
          />
          <Select
            label="Font family"
            className="w-56"
            value={prefs.fontFamily}
            onChange={(value) => set("fontFamily", value)}
            options={fonts.map((name) => ({ value: name, label: name }))}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Advanced">
        <SettingsRow label="Font weight" description="Weight for regular text, 100 to 900.">
          {stepper("fontWeight", "Font weight", LIMITS.fontWeight, 100)}
        </SettingsRow>
        <SettingsRow label="Bold font weight" description="Weight for bold text, 100 to 900.">
          {stepper("fontWeightBold", "Bold font weight", LIMITS.fontWeight, 100)}
        </SettingsRow>
        <SettingsRow label="Line height" description="Row height as a multiple of the font size.">
          {stepper("lineHeight", "Line height", LIMITS.lineHeight, 0.1)}
        </SettingsRow>
        <SettingsRow label="Font ligatures" description={autoNote}>
          <Select
            label="Font ligatures"
            className="w-28"
            value={prefs.ligatures}
            onChange={(value) => set("ligatures", value)}
            options={LIGATURES}
          />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

function Reset({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  return (
    <IconButton
      icon={ArrowCounterClockwiseIcon}
      label="Reset to default"
      className={hidden ? "invisible" : ""}
      onClick={onClick}
    />
  );
}

/** Float steps (0.1) accumulate noise; snapping through toFixed keeps 1.2 as "1.2". */
function snap(value: number, step: number, limits: { min: number; max: number }) {
  return clamp(Number((Math.round(value / step) * step).toFixed(3)), limits);
}

/**
 * Typed edits stay local until blur or Enter, then clamp into range; Escape restores.
 * Callers key it by the committed value so an outside change (reset) drops the draft.
 */
function Stepper({
  label,
  value,
  limits,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  limits: { min: number; max: number };
  step: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = snap(parsed, step, limits);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  const nudge = (direction: 1 | -1) => onCommit(snap(value + direction * step, step, limits));

  return (
    <div className="flex h-8 items-center rounded-md bg-kumo-base px-0.5 ring ring-kumo-line transition-shadow has-[input:focus]:ring-[1.5px] has-[input:focus]:ring-kumo-focus/50">
      <StepButton
        icon={MinusIcon}
        label="Smaller"
        disabled={value <= limits.min}
        onClick={() => nudge(-1)}
      />
      <input
        type="number"
        aria-label={label}
        min={limits.min}
        max={limits.max}
        step={step}
        value={draft}
        className="w-12 [appearance:textfield] bg-transparent text-center tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(String(value));
        }}
      />
      <StepButton
        icon={PlusIcon}
        label="Larger"
        disabled={value >= limits.max}
        onClick={() => nudge(1)}
      />
    </div>
  );
}

function StepButton({
  icon: Glyph,
  label,
  disabled,
  onClick,
}: {
  icon: typeof MinusIcon;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-kumo-subtle outline-none transition-colors hover:bg-hover hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus/50 disabled:bg-transparent disabled:text-placeholder"
    >
      <Glyph className="size-3.5" />
    </button>
  );
}
