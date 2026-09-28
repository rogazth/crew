import { useState } from "react";
import { SearchIcon } from "lucide-react";
import { AgentAvatar } from "../chrome/AgentAvatar";
import type { Confirm } from "../chrome/ConfirmDialog";
import { Kbd } from "../chrome/Kbd";
import { Button, Select, TextInput, Toggle, type Option } from "../chrome/kit";
import { ModelPicker } from "../chrome/ModelPicker";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useAgentAvatar } from "../hooks/useAgentAvatar";
import { useAgentMode } from "../hooks/useAgentMode";
import { useBrowserPrefs } from "../hooks/useBrowserPrefs";
import { useColorMode } from "../hooks/useColorMode";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { useFilePrefs } from "../hooks/useFilePrefs";
import { changeSitePermissions, useSitePermissions } from "../hooks/useSitePermissions";
import { useTabScope } from "../hooks/useTabScope";
import { AGENT_AVATARS } from "../lib/agentAvatar";
import { AGENT_MODES } from "../lib/agentMode";
import { KEEP_CHOICES, SEARCH_ENGINES } from "../lib/browserPrefs";
import { forget, PERMISSION_LABELS, SITE_PERMISSIONS } from "../lib/browser/permissions";
import { COLOR_MODES } from "../lib/colorMode";
import { bindingGroups } from "../lib/commandGroups";
import { commandKeys } from "../lib/commands";
import { BROWSER_CLICK } from "../lib/external";
import { parseFolders } from "../lib/filePrefs";
import { PROVIDERS } from "../lib/providers";
import { settingsSection, type SettingsSectionId } from "../lib/settings";
import type { Workspace } from "../lib/types";
import type { TabScope } from "../lib/worktrees";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { SessionSettings } from "./SessionSettings";
import { TerminalSettings } from "./TerminalSettings";

const TAB_SCOPES: Option<TabScope>[] = [
  { value: "worktree", label: "Per worktree" },
  { value: "all", label: "All together" },
];

export function SettingsView({
  section,
  workspaces,
  onConfirm,
  onOpenTerminal,
}: {
  section: SettingsSectionId;
  workspaces: Workspace[];
  onConfirm: (confirm: Confirm) => void;
  onOpenTerminal: (envId: string) => Promise<void>;
}) {
  const meta = settingsSection(section);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
        <h1 className="px-2.5 text-[20px] leading-tight font-semibold tracking-[-0.26px]">
          {meta.label}
        </h1>
        <div className="flex flex-col gap-8">
          {section === "general" && <General onConfirm={onConfirm} />}
          {section === "appearance" && <Appearance />}
          {section === "keybindings" && <Keybindings />}
          {section === "terminal" && <TerminalSettings />}
          {section === "browser" && <Browser />}
          {section === "environments" && <EnvironmentSettings workspaces={workspaces} onOpenTerminal={onOpenTerminal} />}
          {section === "providers" && <Providers />}
          {section !== "general" &&
            section !== "appearance" &&
            section !== "keybindings" &&
            section !== "terminal" &&
            section !== "browser" &&
            section !== "environments" &&
            section !== "providers" && (
            <Pending label={meta.label} />
          )}
        </div>
      </div>
    </div>
  );
}

function General({ onConfirm }: { onConfirm: (confirm: Confirm) => void }) {
  const tabs = useTabScope();
  const agents = useAgentMode();
  return (
    <>
      <SettingsSection title="Agents">
        <SettingsRow
          label="New agents run in"
          description="Chat shows the agent's work in Crew's timeline, with its tools, diffs and approvals. Terminal runs the provider's own CLI in a terminal tab. Agents you already have keep the way they run."
        >
          <Select label="New agents run in" className="w-40" value={agents.mode} onChange={agents.update} options={AGENT_MODES} />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Worktrees">
        <SettingsRow
          label="Tabs"
          description="Per worktree, each worktree keeps its own tabs and switching swaps them. All together, one strip holds every worktree's tabs, each marked with its branch."
        >
          <Select label="Tabs" className="w-40" value={tabs.scope} onChange={tabs.update} options={TAB_SCOPES} />
        </SettingsRow>
      </SettingsSection>
      <SessionSettings onConfirm={onConfirm} />
      <FileSettings />
    </>
  );
}

function FileSettings() {
  const { prefs, update } = useFilePrefs();
  const saved = prefs.include.join(", ");
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    update({ include: parseFolders(draft) });
    setDraft(null);
  };
  return (
    <SettingsSection title="Files">
      <SettingsRow
        label="Always include"
        description="Folders that file search indexes even when git ignores them. Separate them with commas."
      >
        <div className="w-56">
          <TextInput
            aria-label="Always include"
            placeholder=".ai, .claude"
            value={draft ?? saved}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => event.key === "Enter" && save()}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

const PREVIEW_SEEDS = ["crew", "scout", "atlas", "pilot"];

function Appearance() {
  const avatar = useAgentAvatar();
  const color = useColorMode();
  return (
    <>
      {color.available && (
        <SettingsSection title="Theme">
          <SettingsRow label="Mode" description="Light or dark for the app and its pages. System follows macOS.">
            <Select
              label="Mode"
              className="w-40"
              value={color.mode}
              onChange={color.update}
              options={COLOR_MODES.map((item) => ({ value: item.id, label: item.label }))}
            />
          </SettingsRow>
        </SettingsSection>
      )}
      <SettingsSection title="Agents">
        <SettingsRow label="Avatar style" description="Every agent gets its own face in this style, drawn from its id.">
          <div className="flex items-center gap-3">
            <div className="flex gap-1" aria-hidden>
              {PREVIEW_SEEDS.map((seed) => (
                <AgentAvatar key={seed} seed={seed} bare className="size-6" />
              ))}
            </div>
            <Select
              label="Avatar style"
              className="w-40"
              value={avatar.avatar}
              onChange={avatar.update}
              options={AGENT_AVATARS.map((item) => ({ value: item.id, label: item.label }))}
            />
          </div>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

function Browser() {
  const { prefs, update } = useBrowserPrefs();
  return (
    <>
      <SettingsSection title="Links">
        <Toggle
          label="Open links in Crew"
          description={
            prefs.openLinksInCrew
              ? `Links in agent chats and terminals open as a new page here. ${BROWSER_CLICK}-click one to open it in your default browser instead.`
              : "Links in agent chats and terminals open as a new page here. Off sends them to your default browser."
          }
          checked={prefs.openLinksInCrew}
          onChange={(checked) => update({ ...prefs, openLinksInCrew: checked })}
        />
      </SettingsSection>
      <SettingsSection title="Pages">
        <SettingsRow label="Search engine" description="Where the address bar sends anything that isn't an address.">
          <Select
            label="Search engine"
            className="w-40"
            value={prefs.searchTemplate}
            onChange={(searchTemplate) => update({ ...prefs, searchTemplate })}
            options={SEARCH_ENGINES.map((engine): Option<string> => ({ value: engine.template, label: engine.label }))}
          />
        </SettingsRow>
        <SettingsRow
          label="Background pages"
          description="Hidden tabs that stay loaded for an instant switch back. Each one is a process; the rest reload when shown."
        >
          <Select
            label="Background pages"
            className="w-40"
            value={String(prefs.keep)}
            onChange={(value) => update({ ...prefs, keep: Number(value) })}
            options={KEEP_CHOICES.map((keep) => ({ value: String(keep), label: String(keep) }))}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Downloads">
        <Toggle
          label="Ask where to save each file"
          description={
            prefs.askWhereToSave
              ? "Every download opens a save dialog first."
              : "Files go straight to your Downloads folder. Right-click a link or an image to choose where instead."
          }
          checked={prefs.askWhereToSave}
          onChange={(checked) => update({ ...prefs, askWhereToSave: checked })}
        />
      </SettingsSection>
      <SitePermissionsSettings />
    </>
  );
}

/** Every site with a decision kept, what it may and may not use, and a way to start over. */
function SitePermissionsSettings() {
  const decisions = useSitePermissions();
  const sites = Object.keys(decisions).sort((a, b) => a.localeCompare(b));
  return (
    <SettingsSection title="Site permissions">
      {sites.length === 0 ? (
        <p className="py-3 text-[12px] text-text-muted">
          Sites ask before they use your camera, microphone, location, notifications or clipboard. What you allow or
          block for good shows up here.
        </p>
      ) : (
        sites.map((site) => {
          const decided = decisions[site] ?? {};
          const names = { allow: [] as string[], block: [] as string[] };
          for (const kind of SITE_PERMISSIONS) {
            const decision = decided[kind];
            if (decision) names[decision].push(PERMISSION_LABELS[kind].name);
          }
          const allowed = names.allow.join(", ");
          const blocked = names.block.join(", ");
          return (
            <SettingsRow
              key={site}
              label={site.replace(/^https:\/\//, "")}
              description={[allowed && `Allowed: ${allowed}`, blocked && `Blocked: ${blocked}`].filter(Boolean).join(" · ")}
            >
              <Button
                variant="ghost"
                className="h-7 text-[12px]"
                onClick={() => void changeSitePermissions((current) => forget(current, site))}
              >
                Reset
              </Button>
            </SettingsRow>
          );
        })
      )}
    </SettingsSection>
  );
}

function Providers() {
  const { preferred, installed, update } = useDefaultAgent();
  return (
    <>
      <SettingsSection title="New sessions">
        <SettingsRow
          label="Default agent"
          description={`What ${commandKeys("new-session")} opens. Default runs the model the CLI is configured with.`}
        >
          <div className="w-72">
            <ModelPicker
              provider={preferred.provider}
              model={preferred.model}
              onChange={(provider, model) => update({ provider, model })}
            />
          </div>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Installed">
        {PROVIDERS.map((provider) => {
          const found = installed.includes(provider);
          return (
            <SettingsRow key={provider.id} label={provider.label} description={provider.binary}>
              <ProviderIcon provider={provider.id} className="size-4" />
              <span className={found ? "text-text" : "text-text-muted"}>
                {found ? "Installed" : "Not found"}
              </span>
            </SettingsRow>
          );
        })}
      </SettingsSection>
    </>
  );
}

/** Every binding, grouped the way the app is: tabs, places, agents, finding, view. */
function Keybindings() {
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const groups = bindingGroups()
    .map((group) => ({ ...group, rows: group.rows.filter((row) => !text || row.label.toLowerCase().includes(text)) }))
    .filter((group) => group.rows.length > 0);
  return (
    <>
      <label className="crew-well flex h-10 items-center gap-2.5 px-3.5">
        <SearchIcon className="size-4 shrink-0 text-icon" />
        <input
          value={query}
          placeholder="Search keybindings"
          aria-label="Search keybindings"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder"
        />
      </label>
      {groups.map((group) => (
        <SettingsSection key={group.title} title={group.title}>
          {group.rows.map((row) => (
            <SettingsRow key={row.id} label={row.label}>
              {row.chords.length === 0 ? (
                <span className="text-[12px] text-placeholder">Not bound</span>
              ) : (
                row.chords.map((chord, index) => (
                  <span key={chord} className="flex items-center gap-2">
                    {index > 0 && <span className="text-[11px] text-placeholder">or</span>}
                    <Chord chord={chord} />
                  </span>
                ))
              )}
            </SettingsRow>
          ))}
        </SettingsSection>
      ))}
      {groups.length === 0 && <p className="px-2.5 text-text-muted">No keybinding matches “{query}”.</p>}
    </>
  );
}

const MODIFIER_GLYPHS = new Set(["⌃", "⌥", "⇧", "⌘"]);

/** One keycap per modifier, then the key: ⇧ ⌘ ], the way the keys are pressed. */
function Chord({ chord }: { chord: string }) {
  const glyphs = [...chord];
  const mods = glyphs.filter((glyph) => MODIFIER_GLYPHS.has(glyph));
  const key = glyphs.filter((glyph) => !MODIFIER_GLYPHS.has(glyph)).join("");
  return (
    <span className="flex items-center gap-0.5">
      {[...mods, key].filter(Boolean).map((cap, index) => (
        <Kbd key={index} keys={cap} className="h-6 min-w-6 rounded-md px-1.5 text-[12px] text-text" />
      ))}
    </span>
  );
}

function Pending({ label }: { label: string }) {
  return (
    <SettingsSection>
      <p className="py-4 text-text-muted">{label} settings are not built yet.</p>
    </SettingsSection>
  );
}
