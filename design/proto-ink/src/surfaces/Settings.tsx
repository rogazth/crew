import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  COMMANDS,
  COMMAND_IDS,
  CURSOR_STYLES,
  IS_MAC,
  MONO_FONTS,
  PROVIDERS,
  SETTINGS_SECTIONS,
  commandKeys,
  formatChord,
} from "@crew/fixtures";
import type {
  Chord,
  CommandGroup,
  CommandId,
  CursorStyle,
  SettingsSectionId,
} from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { useApp, type ThemePref } from "@/lib/store";
import { usePref } from "@/lib/store-prefs";
import {
  Badge,
  Button,
  Card,
  Dialog,
  IconButton,
  Input,
  KbdRow,
  Menu,
  MenuItem,
  MenuSeparator,
  ProviderMark,
  ScrollArea,
  Segmented,
  Select,
  SettingRow,
  Switch,
} from "@/ui";
import type { SegmentedOption, SelectOption } from "@/ui";

const BLURB: Record<SettingsSectionId, string> = {
  general: "The workspace this window is pointed at, and what Crew does when it opens.",
  appearance: "How the window reads: theme, density, and what the sidebar shows.",
  terminal: "Type and cursor for every terminal tab in this workspace.",
  providers: "The agent binaries Crew can launch, and whether it found them.",
  keybindings: "Every command the shell binds. Click a chord to change it.",
  about: "Versions, and what this build is made of.",
};

export function Settings() {
  const { page, actions } = useApp();
  const section: SettingsSectionId = page?.kind === "settings" ? page.section : "general";
  const meta = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0]!;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--stroke-tertiary)] px-3">
        <span className="text-body font-[var(--weight-medium)] text-primary">{meta.label}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {section === "keybindings" && (
            <Button size="sm" icon="refresh" onClick={() => actions.resetKeymap()}>
              Reset all
            </Button>
          )}
          <IconButton icon="close" label="Close settings" onClick={() => actions.closePage()} />
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          <div className="mb-6 px-1">
            <h1 className="text-title text-primary">{meta.label}</h1>
            <p className="mt-1 text-body text-tertiary">{BLURB[meta.id]}</p>
          </div>
          <div className="flex flex-col gap-6 pb-10">
            <SectionBody section={meta.id} />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function SectionBody({ section }: { section: SettingsSectionId }) {
  switch (section) {
    case "appearance":
      return <AppearanceSection />;
    case "terminal":
      return <TerminalSection />;
    case "providers":
      return <ProvidersSection />;
    case "keybindings":
      return <KeybindingsSection />;
    case "about":
      return <AboutSection />;
    case "general":
    default:
      return <GeneralSection />;
  }
}

/* -- General --------------------------------------------------------------- */

const AUTONOMY_OPTIONS: SelectOption[] = [
  { value: "ask", label: "Ask first", note: "Approve each action" },
  { value: "auto", label: "Run autonomously" },
];

function GeneralSection() {
  const { workspace, actions } = useApp();
  const [startOnLaunch, setStartOnLaunch] = usePref("settings.startOnLaunch", true);
  const [confirmClose, setConfirmClose] = usePref("settings.confirmClose", true);
  const [autonomy, setAutonomy] = usePref("settings.autonomy", "ask");

  return (
    <>
      <Card title="Workspace">
        <SettingRow
          label={workspace.name}
          description={<span className="ink-mono block truncate">{workspace.path}</span>}
          control={
            <Button onClick={() => actions.openPalette("sessions")}>Change…</Button>
          }
        />
      </Card>

      <Card title="Behaviour">
        <SettingRow
          label="Start on launch"
          description="Open Crew when you log in, with the windows you left open."
          control={<Switch checked={startOnLaunch} onCheckedChange={setStartOnLaunch} />}
        />
        <SettingRow
          label="Confirm before closing a live tab"
          description="A session that is working or waiting on you asks before its tab goes away."
          control={<Switch checked={confirmClose} onCheckedChange={setConfirmClose} />}
        />
        <SettingRow
          label="Default autonomy for new agents"
          description="What a freshly created agent does when it wants to run a command."
          control={
            <Select
              value={autonomy}
              onValueChange={setAutonomy}
              options={AUTONOMY_OPTIONS}
              width={200}
            />
          }
        />
      </Card>
    </>
  );
}

/* -- Appearance ------------------------------------------------------------ */

const THEME_OPTIONS: SegmentedOption<ThemePref>[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];

const AGENT_THEMES: SelectOption[] = [
  { value: "ink", label: "Ink", note: "Default" },
  { value: "paper", label: "Paper" },
  { value: "carbon", label: "Carbon" },
  { value: "terminal", label: "Terminal" },
];

type Density = "comfortable" | "compact";

const DENSITY_OPTIONS: SegmentedOption<Density>[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

function AppearanceSection() {
  const { theme, agentTheme, prefs, actions } = useApp();
  const [density, setDensity] = usePref<Density>("settings.density", "comfortable");
  const [reduceMotion, setReduceMotion] = usePref("settings.reduceMotion", false);

  // Both land on <html> so any surface can opt in by reading the attribute.
  // Today only the transcript reads `data-density`.
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  useEffect(() => {
    document.documentElement.dataset.motion = reduceMotion ? "reduced" : "";
  }, [reduceMotion]);

  return (
    <>
      <Card title="Theme">
        <SettingRow
          label="Theme"
          description="System follows the OS setting and flips with it."
          control={
            <Segmented value={theme} onChange={actions.setTheme} options={THEME_OPTIONS} />
          }
        />
        <SettingRow
          label="Agent theme"
          description="The colour set the agent transcript is painted with."
          control={
            <Select
              value={agentTheme}
              onValueChange={actions.setAgentTheme}
              options={AGENT_THEMES}
              width={160}
            />
          }
        />
      </Card>

      <Card title="Interface">
        <SettingRow
          label="Interface density"
          description="Compact tightens row heights and leading."
          control={<Segmented value={density} onChange={setDensity} options={DENSITY_OPTIONS} />}
        />
        <SettingRow
          label="Show avatars in the sidebar"
          description="The identity tile on each session row."
          control={
            <Switch
              checked={prefs.showAvatar}
              onCheckedChange={(showAvatar) => actions.setPrefs({ showAvatar })}
            />
          }
        />
        <SettingRow
          label="Reduce motion"
          description="Stills the breathing status dot and the sweeping progress hairline."
          control={<Switch checked={reduceMotion} onCheckedChange={setReduceMotion} />}
        />
      </Card>
    </>
  );
}

/* -- Terminal -------------------------------------------------------------- */

const CURSOR_LABEL: Record<CursorStyle, string> = {
  block: "Block",
  bar: "Bar",
  underline: "Underline",
};

const CURSOR_OPTIONS: SegmentedOption<CursorStyle>[] = CURSOR_STYLES.map((style) => ({
  value: style,
  label: CURSOR_LABEL[style],
}));

const FONT_MIN = 10;
const FONT_MAX = 20;

function TerminalCursor({ style }: { style: CursorStyle }) {
  return (
    <span
      aria-hidden
      className={cx(
        "ml-[1px] inline-block bg-[var(--term-default)] opacity-80",
        style === "block" && "h-[1.05em] w-[0.58em] align-text-bottom",
        style === "bar" && "h-[1.05em] w-[2px] align-text-bottom",
        style === "underline" && "h-[2px] w-[0.58em] align-baseline",
      )}
    />
  );
}

function TerminalSection() {
  const { terminal, actions } = useApp();
  const fonts = useMemo<SelectOption[]>(
    () => MONO_FONTS.map((font) => ({ value: font, label: font })),
    [],
  );
  const size = terminal.fontSize;

  return (
    <Card title="Terminal">
      <SettingRow
        label="Font family"
        description="Falls back to the system monospace stack when the face is missing."
        control={
          <Select
            value={terminal.fontFamily}
            onValueChange={(fontFamily) => actions.setTerminal({ fontFamily })}
            options={fonts}
            width={200}
          />
        }
      />
      <SettingRow
        label="Font size"
        description={`${FONT_MIN}–${FONT_MAX} px.`}
        control={
          <div className="flex items-center gap-1.5">
            <IconButton
              icon="minus"
              label="Decrease font size"
              size="sm"
              disabled={size <= FONT_MIN}
              onClick={() => actions.setTerminal({ fontSize: Math.max(FONT_MIN, size - 1) })}
            />
            <span className="tnum w-6 text-center text-body text-primary">{size}</span>
            <IconButton
              icon="plus"
              label="Increase font size"
              size="sm"
              disabled={size >= FONT_MAX}
              onClick={() => actions.setTerminal({ fontSize: Math.min(FONT_MAX, size + 1) })}
            />
          </div>
        }
      />
      <SettingRow
        label="Cursor style"
        description="Shown in the preview below."
        control={
          <Segmented
            value={terminal.cursorStyle}
            onChange={(cursorStyle) => actions.setTerminal({ cursorStyle })}
            options={CURSOR_OPTIONS}
          />
        }
      />
      <SettingRow
        stacked
        label="Preview"
        description="Live — it is drawn with the settings above."
        control={
          <div
            className="rounded-md bg-recessed px-3 py-2.5 hairline-soft"
            style={{
              fontFamily: `"${terminal.fontFamily}", var(--font-mono)`,
              fontSize: terminal.fontSize,
              lineHeight: 1.55,
              letterSpacing: 0,
            }}
          >
            <div>
              <span className="text-[var(--term-path)]">~/crew</span>{" "}
              <span className="text-[var(--term-dim)]">on</span>{" "}
              <span className="text-[var(--term-ok)]">main</span>
            </div>
            <div>
              <span className="text-[var(--term-prompt)]">❯</span>{" "}
              <span className="text-[var(--term-default)]">npm run build</span>
            </div>
            <div className="text-[var(--term-dim)]">vite v7.1.12 building for production…</div>
            <div>
              <span className="text-[var(--term-ok)]">✓</span>{" "}
              <span className="text-[var(--term-default)]">418 modules transformed in 1.24s</span>
            </div>
            <div>
              <span className="text-[var(--term-error)]">warn</span>{" "}
              <span className="text-[var(--term-dim)]">2 chunks are larger than 500 kB</span>
            </div>
            <div>
              <span className="text-[var(--term-prompt)]">❯</span>
              <TerminalCursor style={terminal.cursorStyle} />
            </div>
          </div>
        }
      />
    </Card>
  );
}

/* -- Providers ------------------------------------------------------------- */

/** Installed-ness is a daemon fact; the prototype states it as one. */
const INSTALLED = new Set(["claude", "cursor", "codex"]);

function ProvidersSection() {
  return (
    <>
      <Card title="Providers">
        {PROVIDERS.map((provider) => {
          const ready = INSTALLED.has(provider.id);
          return (
            <SettingRow
              key={provider.id}
              label={
                <span className="flex items-center gap-2">
                  <ProviderMark provider={provider.id} />
                  {provider.label}
                </span>
              }
              description={<span className="ink-mono">{provider.binary}</span>}
              control={
                <div className="flex items-center gap-2">
                  <Badge tone={ready ? "success" : "neutral"}>
                    {ready ? "Ready" : "Not installed"}
                  </Badge>
                  <Menu
                    align="end"
                    trigger={
                      <Button
                        tone="ghost"
                        size="sm"
                        trailing={
                          <Icon name="chevronDown" size={14} className="-mr-0.5 opacity-70" />
                        }
                      >
                        Configure
                      </Button>
                    }
                  >
                    <MenuItem icon="folder">Set binary path…</MenuItem>
                    <MenuItem icon="fileText">View logs</MenuItem>
                    <MenuSeparator />
                    <MenuItem icon="external">Sign out</MenuItem>
                  </Menu>
                </div>
              }
            />
          );
        })}
      </Card>
      <p className="px-1 text-small text-tertiary">
        Provider binaries are discovered and authenticated by the daemon — the renderer only
        reports what crewd found. Changing a path or signing out is a request sent to the daemon,
        not a setting stored in this window.
      </p>
    </>
  );
}

/* -- Keybindings ----------------------------------------------------------- */

const GROUP_ORDER: CommandGroup[] = ["Tabs", "Navigate", "Create", "Terminal", "View", "File"];

const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt", "CapsLock"]);

function KeybindingsSection() {
  const { keymap, actions } = useApp();
  const [query, setQuery] = useState("");
  const [capturing, setCapturing] = useState<CommandId | null>(null);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return GROUP_ORDER.map((group) => ({
      group,
      rows: COMMAND_IDS.filter((id) => COMMANDS[id].group === group)
        .map((id) => {
          // A reset writes "" rather than deleting the key, so an empty override
          // means "use the default" — not "no chord".
          const override = keymap[id];
          return {
            id,
            label: COMMANDS[id].label,
            chord: override ? override : commandKeys(id),
            overridden: Boolean(override),
          };
        })
        .filter(
          (row) =>
            !needle ||
            row.label.toLowerCase().includes(needle) ||
            row.chord.toLowerCase().includes(needle),
        ),
    })).filter((entry) => entry.rows.length > 0);
  }, [query, keymap]);

  const capture = (id: CommandId, event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Tab") {
      setCapturing(null);
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    const chord: Chord = {
      key: event.key === " " ? "Space" : event.key,
      mod: IS_MAC ? event.metaKey : event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: IS_MAC ? event.ctrlKey : false,
    };
    actions.setKeymap(id, formatChord(chord));
    setCapturing(null);
  };

  return (
    <>
      <Input
        icon="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter commands"
        aria-label="Filter commands"
        className="w-full"
        trailing={
          query ? (
            <IconButton icon="close" label="Clear filter" size="sm" onClick={() => setQuery("")} />
          ) : null
        }
      />

      {groups.map(({ group, rows }) => (
        <Card key={group} title={group}>
          {rows.map((row) => {
            const live = capturing === row.id;
            return (
              <div key={row.id} className="flex h-9 items-center gap-3 px-3.5">
                <span className="min-w-0 flex-1 truncate text-body text-primary">{row.label}</span>
                <span className="flex w-12 shrink-0 justify-end">
                  {row.overridden && (
                    <button
                      type="button"
                      onClick={() => actions.clearKeymap(row.id)}
                      className={cx(
                        "rounded-sm px-1 py-0.5 text-micro text-tertiary",
                        "transition-colors duration-[var(--dur-2)]",
                        "hover:bg-[var(--fill-tertiary)] hover:text-primary",
                      )}
                    >
                      Reset
                    </button>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={`Change the chord for ${row.label}`}
                  onClick={() => setCapturing(row.id)}
                  onKeyDown={live ? (event) => capture(row.id, event) : undefined}
                  onBlur={live ? () => setCapturing(null) : undefined}
                  className={cx(
                    "flex h-6 min-w-[188px] shrink-0 items-center justify-end gap-1 rounded-md px-1.5",
                    "whitespace-nowrap transition-colors duration-[var(--dur-2)]",
                    live
                      ? "bg-[var(--accent-fill)]"
                      : "bg-transparent hover:bg-[var(--fill-tertiary)]",
                  )}
                >
                  {live ? (
                    <span className="text-micro text-[var(--accent)]">
                      Press a chord… Esc to cancel
                    </span>
                  ) : (
                    <KbdRow chord={row.chord} />
                  )}
                </button>
              </div>
            );
          })}
        </Card>
      ))}

      {groups.length === 0 && (
        <p className="px-1 py-6 text-center text-body text-tertiary">
          No command matches “{query}”.
        </p>
      )}

      {/*
        The capture only records a display string: rebinding the real listener is a
        shell change this prototype does not make.
      */}
      <p className="px-1 text-small text-tertiary">
        A chord you record is stored and shown here, but the shell keeps listening for the
        default binding.
      </p>
    </>
  );
}

/* -- About ----------------------------------------------------------------- */

const VERSION = "0.4.0";
const BUILD = "2026-09-18 · 60687a9";

const LICENSES: Array<{ name: string; version: string; license: string }> = [
  { name: "react", version: "19.1.0", license: "MIT" },
  { name: "react-dom", version: "19.1.0", license: "MIT" },
  { name: "@base-ui/react", version: "1.7.0", license: "MIT" },
  { name: "lucide-react", version: "0.563.0", license: "ISC" },
  { name: "tailwindcss", version: "4.1.14", license: "MIT" },
  { name: "shiki", version: "4.4.3", license: "MIT" },
  { name: "react-markdown", version: "10.1.0", license: "MIT" },
  { name: "vite", version: "7.1.12", license: "MIT" },
];

function Mono({ children }: { children: ReactNode }) {
  return <span className="ink-mono tnum text-tertiary">{children}</span>;
}

function AboutSection() {
  const [licenses, setLicenses] = useState(false);

  return (
    <>
      <Card title="Build">
        <SettingRow
          label="Crew"
          description="A desktop workbench for running several coding agents at once."
          control={<Mono>{VERSION}</Mono>}
        />
        <SettingRow label="Built" description="This bundle." control={<Mono>{BUILD}</Mono>} />
        <SettingRow
          label="Daemon"
          description="Owns the sessions, the PTYs and the provider binaries."
          control={<Mono>crewd {VERSION}</Mono>}
        />
        <SettingRow
          label="Renderer"
          description="React 19 on Vite, Base UI primitives."
          control={<Mono>19.1 · 7.1</Mono>}
        />
        <SettingRow
          label="Design prototypes"
          description="Three proposals for the same app; this window is one of them."
          control={
            <div className="flex items-center gap-2 text-small">
              <Badge tone="accent">Ink</Badge>
              <span className="text-quaternary">Console</span>
              <span className="text-quaternary">Canvas</span>
            </div>
          }
        />
        <SettingRow
          label="Licenses"
          description="Open-source components in this build."
          control={
            <Button tone="ghost" onClick={() => setLicenses(true)}>
              View
            </Button>
          }
        />
      </Card>

      <Dialog open={licenses} onOpenChange={setLicenses} width={420} className="overflow-hidden">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--stroke-tertiary)] px-3 pl-4">
          <span className="text-body font-[var(--weight-medium)] text-primary">Licenses</span>
          <IconButton
            icon="close"
            label="Close"
            className="ml-auto"
            onClick={() => setLicenses(false)}
          />
        </div>
        <ul className="ink-scroll max-h-[min(420px,60vh)] overflow-y-auto px-4 py-1">
          {LICENSES.map((dep) => (
            <li
              key={dep.name}
              className="flex items-center justify-between gap-4 border-b border-[var(--stroke-tertiary)] py-2 last:border-b-0"
            >
              <span className="ink-mono min-w-0 truncate text-secondary">{dep.name}</span>
              <span className="shrink-0 text-small text-tertiary">
                <span className="tnum">{dep.version}</span> · {dep.license}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end border-t border-[var(--stroke-tertiary)] px-4 py-3">
          <Button onClick={() => setLicenses(false)}>Close</Button>
        </div>
      </Dialog>
    </>
  );
}
