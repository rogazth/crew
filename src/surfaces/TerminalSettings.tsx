import { Button, Select } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useTerminalPrefs } from "../hooks/useTerminalPrefs";
import { installedMonoFonts } from "../lib/fonts";
import { DEFAULT_TERMINAL_PREFS, LIMITS, type Ligatures, type TerminalPrefs } from "../lib/terminalPrefs";
import { commitStep, ligaturesNote, nudge as nudged } from "../lib/terminalSettingsView";

const LIGATURES: { value: Ligatures; label: string }[] = [
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

  const autoNote = ligaturesNote(prefs);

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
            aria-label="Font family"
            size="sm"
            className="w-56"
            value={prefs.fontFamily}
            onValueChange={(value) => value && set("fontFamily", value)}
            items={fonts.map((name) => ({ value: name, label: name }))}
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
            aria-label="Font ligatures"
            size="sm"
            className="w-28"
            value={prefs.ligatures}
            onValueChange={(value) => value && set("ligatures", value as Ligatures)}
            items={LIGATURES}
          />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

function Reset({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      shape="square"
      size="sm"
      icon={ArrowCounterClockwiseIcon}
      aria-label="Reset to default"
      className={`text-kumo-subtle ${hidden ? "invisible" : ""}`}
      onClick={onClick}
    />
  );
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
    const next = commitStep(draft, value, step, limits);
    setDraft(next.draft);
    if (next.commit !== null) onCommit(next.commit);
  };
  const nudge = (direction: 1 | -1) => onCommit(nudged(value, direction, step, limits));

  return (
    <div className="flex h-7 items-center rounded-md bg-kumo-control ring ring-kumo-line has-[input:focus]:ring-[1.5px] has-[input:focus]:ring-kumo-focus/50">
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
      className="flex size-7 items-center justify-center rounded-md text-kumo-subtle transition-colors hover:text-kumo-default disabled:text-kumo-placeholder"
    >
      <Glyph className="size-3.5" />
    </button>
  );
}
