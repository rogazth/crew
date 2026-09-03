import { Button, Collapsible, Input, Select } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  MinusIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
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

  const autoNote = ligaturesEnabled({ ...prefs, ligatures: "auto" })
    ? `Auto - enabled for "${prefs.fontFamily}".`
    : `Auto - disabled for "${prefs.fontFamily}".`;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-medium">Typography</h2>

      <Group>
        <Row label="Font size">
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              shape="square"
              size="sm"
              icon={MinusIcon}
              aria-label="Smaller"
              disabled={prefs.fontSize <= LIMITS.fontSize.min}
              onClick={() => set("fontSize", prefs.fontSize - 1)}
            />
            <NumberField
              key={prefs.fontSize}
              label="Font size"
              value={prefs.fontSize}
              limits={LIMITS.fontSize}
              onCommit={(value) => set("fontSize", value)}
            />
            <Button
              variant="secondary"
              shape="square"
              size="sm"
              icon={PlusIcon}
              aria-label="Larger"
              disabled={prefs.fontSize >= LIMITS.fontSize.max}
              onClick={() => set("fontSize", prefs.fontSize + 1)}
            />
            <Unit>px</Unit>
          </div>
        </Row>

        <Row label="Font family">
          <div className="flex w-64 items-center gap-1.5">
            <Select
              hideLabel
              label="Font family"
              size="sm"
              className="min-w-0 flex-1"
              value={prefs.fontFamily}
              onValueChange={(value) => value && set("fontFamily", value)}
              items={fonts.map((name) => ({ value: name, label: name }))}
            />
            <Reset
              hidden={prefs.fontFamily === DEFAULT_TERMINAL_PREFS.fontFamily}
              onClick={() => set("fontFamily", DEFAULT_TERMINAL_PREFS.fontFamily)}
            />
          </div>
        </Row>
      </Group>

      <Collapsible.Root>
        <Collapsible.Trigger className="group flex items-center gap-1.5 rounded-md py-1 pr-2 font-medium text-kumo-default outline-none hover:text-kumo-default focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50">
          <CaretDownIcon className="size-3.5 -rotate-90 text-kumo-subtle transition-transform group-data-panel-open:rotate-0" />
          Advanced
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <div className="pt-3">
            <Group>
              <Row label="Font weight" hint={`Default: ${DEFAULT_TERMINAL_PREFS.fontWeight}`}>
                <NumberField
                  key={prefs.fontWeight}
                  label="Font weight"
                  value={prefs.fontWeight}
                  limits={LIMITS.fontWeight}
                  step={100}
                  onCommit={(value) => set("fontWeight", value)}
                />
                <Unit>100-900</Unit>
              </Row>
              <Row
                label="Bold font weight"
                hint={`Default: ${DEFAULT_TERMINAL_PREFS.fontWeightBold}`}
              >
                <NumberField
                  key={prefs.fontWeightBold}
                  label="Bold font weight"
                  value={prefs.fontWeightBold}
                  limits={LIMITS.fontWeight}
                  step={100}
                  onCommit={(value) => set("fontWeightBold", value)}
                />
                <Unit>100-900</Unit>
              </Row>
              <Row label="Line height" hint={`Default: ${DEFAULT_TERMINAL_PREFS.lineHeight}`}>
                <NumberField
                  key={prefs.lineHeight}
                  label="Line height"
                  value={prefs.lineHeight}
                  limits={LIMITS.lineHeight}
                  step={0.1}
                  onCommit={(value) => set("lineHeight", value)}
                />
                <Unit>1-3</Unit>
              </Row>
              <Row label="Font ligatures" hint={autoNote}>
                <Segmented
                  options={LIGATURES}
                  value={prefs.ligatures}
                  onChange={(value) => set("ligatures", value)}
                />
              </Row>
            </Group>
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </section>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg ring ring-kumo-line">
      {children}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-4 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] text-kumo-subtle">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Unit({ children }: { children: React.ReactNode }) {
  return <span className="w-14 text-[11px] text-kumo-subtle tabular-nums">{children}</span>;
}

function Reset({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      shape="square"
      size="sm"
      icon={ArrowCounterClockwiseIcon}
      aria-label="Reset to default"
      className={hidden ? "invisible" : ""}
      onClick={onClick}
    />
  );
}

/**
 * Edits stay local until blur or Enter, then clamp into range; Escape restores.
 * Callers key it by the committed value so an outside change (the stepper) resets the draft.
 */
function NumberField({
  label,
  value,
  limits,
  step = 1,
  onCommit,
}: {
  label: string;
  value: number;
  limits: { min: number; max: number };
  step?: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clamp(Math.round(parsed / step) * step, limits);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <Input
      type="number"
      size="sm"
      aria-label={label}
      min={limits.min}
      max={limits.max}
      step={step}
      value={draft}
      className="w-20 text-center tabular-nums"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(String(value));
      }}
    />
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" className="flex rounded-lg bg-kumo-control p-0.5 ring ring-kumo-line">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-3 py-1 transition-colors ${
              active ? "bg-selected text-kumo-default" : "text-kumo-subtle hover:text-kumo-default"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
