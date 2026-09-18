import type { Density, Theme } from "@/lib/prefs";
import {
  Avatar,
  Button,
  Card,
  Kbd,
  ProviderMark,
  Row,
  Segmented,
  Select,
  StatusMark,
  type SegmentedOption,
  type SelectOption,
} from "@/ui";
import { store, useApp } from "@/lib/store";
import { setLocal, useLocal, type AgentTheme } from "./local";

const THEMES: Array<SegmentedOption<Theme>> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System", title: "Follow the operating system" },
];

const DENSITIES: Array<SegmentedOption<Density>> = [
  { id: "comfortable", label: "Comfortable", title: "28px rows" },
  { id: "compact", label: "Compact", title: "22px rows" },
];

const AGENT_THEMES: Array<SelectOption<AgentTheme>> = [
  { id: "auto", label: "Auto", note: "default" },
  { id: "provider", label: "Provider", note: "cl cx cd" },
  { id: "identity", label: "Identity", note: "per name" },
  { id: "none", label: "None", note: "grey" },
];

export function Appearance() {
  const state = useApp();
  const local = useLocal();

  return (
    <>
      <Card title="Interface">
        <Row
          label="Theme"
          description="System follows the operating system. ⇧⌘J flips light and dark from anywhere in the window."
          control={
            <Segmented
              value={state.theme}
              options={THEMES}
              onChange={(next) => store.setTheme(next)}
              label="Theme"
            />
          }
        />
        <Row
          label="Density"
          description="Row height 28px comfortable, 22px compact. It moves every list row, tab, menu item and control in the window at once."
          control={
            <Segmented
              value={state.density}
              options={DENSITIES}
              onChange={(next) => store.setDensity(next)}
              label="Density"
            />
          }
        />
        <Row
          label="Agent theme"
          description="Where an agent's mark takes its colour from: the provider, the name, or nothing. Presentational only, and kept in this window — the daemon does not store it yet."
          control={
            <Select
              value={local.agentTheme}
              options={AGENT_THEMES}
              onChange={(next) => setLocal({ agentTheme: next })}
              label="Agent theme"
              shape="chip"
            />
          }
        />
      </Card>

      <Card title="Preview">
        <Row
          stacked
          label="At the current density"
          description="A sidebar row, a button, a keycap and a status mark, drawn with the settings above."
          control={<Preview theme={local.agentTheme} density={state.density} />}
        />
      </Card>
    </>
  );
}

function Mark({ theme }: { theme: AgentTheme }) {
  if (theme === "identity") return <Avatar seed="harness" size={14} />;
  if (theme === "none") {
    return (
      <span
        style={{ fontSize: 8 }}
        className="inline-grid size-[14px] shrink-0 place-items-center rounded-[var(--r)] bg-sunken font-mono leading-none text-ink-4"
      >
        cl
      </span>
    );
  }
  return <ProviderMark provider="claude" />;
}

function Preview({ theme, density }: { theme: AgentTheme; density: Density }) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--r)] border border-rule bg-bg p-2">
      <div className="flex h-[var(--row-h)] items-center gap-2 rounded-[var(--r)] bg-raised px-2 font-mono text-sm">
        <span className="w-[14px] shrink-0 text-right text-ink-4">1</span>
        <Mark theme={theme} />
        <span className="truncate text-ink">harness</span>
        <span className="ml-auto shrink-0 text-ink-4">opus-5</span>
        <StatusMark status="working" />
      </div>
      <div className="flex items-center gap-3">
        <Button>Open</Button>
        <Kbd>⌘K</Kbd>
        <span className="flex items-center gap-1.5">
          <StatusMark status="needs-input" />
          <span className="font-mono text-xs text-ink-3">needs input</span>
        </span>
        <span className="ml-auto font-mono text-xs text-ink-4">
          row-h {density === "compact" ? "22px" : "28px"}
        </span>
      </div>
    </div>
  );
}
