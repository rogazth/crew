import { useEffect, useState } from "react";
import {
  COMMANDS,
  COMMAND_IDS,
  CURSOR_STYLES,
  MONO_FONTS,
  PROVIDERS,
  formatChord,
  type Chord,
  type CommandId,
  type SettingsSectionId,
} from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useStore, type AgentTheme, type ThemeChoice } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Row, Section } from "@/ui/Field";
import { Icon } from "@/ui/Icon";
import { Kbd } from "@/ui/Kbd";
import { Input } from "@/ui/Input";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";
import { Toggle } from "@/ui/Toggle";
import { Cursor } from "./Terminal";

const TITLE: Record<SettingsSectionId, string> = {
  general: "General",
  appearance: "Appearance",
  terminal: "Terminal",
  providers: "Providers",
  keybindings: "Keybindings",
  about: "About",
};

export function SettingsPage({ section }: { section: SettingsSectionId }) {
  return (
    <div className="scroller min-h-0 flex-1">
      <div className="mx-auto w-full max-w-[768px] px-8 pb-24 pt-14">
        <h1 className="mb-8 text-xl">{TITLE[section]}</h1>
        {section === "general" && <General />}
        {section === "appearance" && <Appearance />}
        {section === "terminal" && <TerminalSettings />}
        {section === "providers" && <Providers />}
        {section === "keybindings" && <Keybindings />}
        {section === "about" && <About />}
      </div>
    </div>
  );
}

function General() {
  const { workspaces, workspaceId, prefs, setPrefs } = useStore();
  const [reopen, setReopen] = useState(true);
  const [confirmClose, setConfirmClose] = useState(true);
  const workspace = workspaces.find((entry) => entry.id === workspaceId);

  return (
    <>
      <Section title="Workspace">
        <Row label="Active workspace" description={workspace?.path ?? ""}>
          <Badge tone="accent">{workspace?.name}</Badge>
        </Row>
        <Row label="Reopen the last workspace on launch" description="Otherwise Crew opens the picker.">
          <Toggle checked={reopen} onChange={setReopen} label="Reopen last workspace" />
        </Row>
      </Section>

      <Section title="Sessions">
        <Row label="Confirm before closing a live session" description="A running turn keeps going in the background either way.">
          <Toggle checked={confirmClose} onChange={setConfirmClose} label="Confirm before closing" />
        </Row>
        <Row label="Group the sidebar by" description="What the session list uses when nothing is filtered.">
          <Select
            size="sm"
            value={prefs.grouping}
            onChange={(grouping) => setPrefs({ ...prefs, grouping })}
            options={[
              { value: "none", label: "None" },
              { value: "kind", label: "Kind" },
              { value: "provider", label: "Provider" },
              { value: "status", label: "Status" },
            ]}
          />
        </Row>
      </Section>
    </>
  );
}

function Appearance() {
  const { theme, setTheme, agentTheme, setAgentTheme, prefs, setPrefs, sessions } = useStore();
  const preview = sessions.filter((session) => session.kind === "agent").slice(0, 6);

  return (
    <>
      <Section title="Theme">
        <Row label="Appearance" description="Canvas ships one accent and two surfaces per theme.">
          <Segmented
            size="sm"
            value={theme}
            onChange={(next) => setTheme(next as ThemeChoice)}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
          />
        </Row>
      </Section>

      <Section title="Agents" description="How each agent's face and rail get their colour.">
        <Row
          label="Agent theme"
          description="Generated hues come from the agent's name, so the same name is always the same face."
        >
          <Select
            size="sm"
            value={agentTheme}
            onChange={(next) => setAgentTheme(next as AgentTheme)}
            options={[
              { value: "generated", label: "Generated" },
              { value: "provider", label: "By provider" },
              { value: "mono", label: "Monochrome" },
            ]}
          />
        </Row>
        <Row label="Avatars in the sidebar" description="Off falls back to a status dot.">
          <Toggle
            checked={prefs.show.avatar}
            onChange={(next) => setPrefs({ ...prefs, show: { ...prefs.show, avatar: next } })}
            label="Sidebar avatars"
          />
        </Row>
        <div className="flex items-center gap-3 px-4 py-4">
          {preview.map((session) => (
            <div key={session.id} className="flex flex-col items-center gap-1.5">
              <Avatar seed={session.name} size={36} status={session.status} />
              <span className="text-xs text-ink-38">{session.name}</span>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function TerminalSettings() {
  const { terminalPrefs, setTerminalPrefs } = useStore();
  return (
    <>
      <Section title="Terminal">
        <Row label="Font family" description="Monospace faces found on this machine.">
          <Select
            size="sm"
            value={terminalPrefs.fontFamily}
            onChange={(fontFamily) => setTerminalPrefs({ ...terminalPrefs, fontFamily })}
            options={MONO_FONTS.map((font) => ({ value: font, label: font }))}
          />
        </Row>
        <Row label="Font size" description="Also bound to the zoom shortcuts.">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              icon="zoomOut"
              aria-label="Smaller"
              onClick={() => setTerminalPrefs({ ...terminalPrefs, fontSize: Math.max(9, terminalPrefs.fontSize - 1) })}
            />
            <span className="w-10 text-center text-base tabular-nums">{terminalPrefs.fontSize}px</span>
            <Button
              size="sm"
              icon="zoomIn"
              aria-label="Larger"
              onClick={() => setTerminalPrefs({ ...terminalPrefs, fontSize: Math.min(22, terminalPrefs.fontSize + 1) })}
            />
          </div>
        </Row>
        <Row label="Cursor" description="Block, bar or underline.">
          <Segmented
            size="sm"
            value={terminalPrefs.cursor}
            onChange={(cursor) => setTerminalPrefs({ ...terminalPrefs, cursor })}
            options={CURSOR_STYLES.map((style) => ({ value: style, label: style }))}
          />
        </Row>
      </Section>

      <Section title="Preview">
        <div
          className="bg-term-bg px-4 py-3 font-mono"
          style={{ fontFamily: terminalPrefs.fontFamily, fontSize: terminalPrefs.fontSize, lineHeight: 1.55 }}
        >
          <div>
            <span className="text-[var(--ok)]">➜</span> <span className="text-accent-text">crew</span>{" "}
            <span className="text-ink-38">git:(</span>
            <span className="text-[var(--danger)]">master</span>
            <span className="text-ink-38">)</span> npm run check
          </div>
          <div className="text-ink-38">&gt; tsc --noEmit &amp;&amp; vitest run</div>
          <div>
            <span className="text-[var(--ok)]">✓</span> 107 passed <span className="text-ink-38">(1.28s)</span>
          </div>
          <div>
            <span className="text-[var(--ok)]">➜</span> <span className="text-accent-text">crew</span>{" "}
            <Cursor style={terminalPrefs.cursor} />
          </div>
        </div>
      </Section>
    </>
  );
}

function Providers() {
  return (
    <>
      <Section title="Installed" description="Crew shells out to whichever agent CLI you already use.">
        {PROVIDERS.map((provider) => (
          <Row key={provider.id} label={provider.label} description={`${provider.binary} · ${provider.models.length} models`}>
            <Badge tone="ok">
              <Icon name="check" size={11} />
              found
            </Badge>
          </Row>
        ))}
      </Section>
      <Section title="Credentials">
        <div className="px-4 py-6 text-center text-sm text-ink-38">
          Nothing to configure yet — every provider reads the credentials its own CLI already stored.
        </div>
      </Section>
    </>
  );
}

function Keybindings() {
  const { chordFor, setChord } = useStore();
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
      const chord: Chord = {
        key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
        ...(event.metaKey || event.ctrlKey ? { mod: true } : {}),
        ...(event.shiftKey ? { shift: true } : {}),
        ...(event.altKey ? { alt: true } : {}),
      };
      setChord(recording, chord);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, setChord]);

  const groups = [...new Set(COMMAND_IDS.map((id) => COMMANDS[id].group))];
  const needle = query.trim().toLowerCase();

  return (
    <>
      <div className="mb-5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter commands"
          leading={<Icon name="search" size={14} className="text-ink-38" />}
        />
      </div>
      {groups.map((group) => {
        const ids = COMMAND_IDS.filter(
          (id) => COMMANDS[id].group === group && (!needle || COMMANDS[id].label.toLowerCase().includes(needle)),
        );
        if (ids.length === 0) return null;
        return (
          <Section key={group} title={group}>
            {ids.map((id) => (
              <Row key={id} label={COMMANDS[id].label}>
                <button
                  type="button"
                  onClick={() => setRecording(id)}
                  className={cx(
                    "rise-1 flex h-7 items-center gap-2 rounded-chip px-2 text-sm",
                    recording === id ? "bg-accent-soft text-accent-text" : "text-ink-52 hover:bg-sunken hover:text-ink",
                  )}
                >
                  {recording === id ? "Press a key…" : <Kbd>{formatChord(chordFor(id))}</Kbd>}
                </button>
              </Row>
            ))}
          </Section>
        );
      })}
    </>
  );
}

function About() {
  return (
    <Section title="About">
      <Row label="Crew" description="Prototype C — Canvas" >
        <Badge tone="accent">0.0.0-canvas</Badge>
      </Row>
      <Row label="Renderer" description="React 19 · Tailwind v4 · Base UI. No Kumo." />
      <Row label="Data" description="Everything on screen comes from @crew/fixtures. There is no daemon behind this window." />
    </Section>
  );
}
