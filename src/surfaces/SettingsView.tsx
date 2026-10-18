import { lazy, Suspense, useEffect, useState } from "react";
import { SearchIcon } from "lucide-react";
import { BotAvatar } from "../chrome/BotAvatar";
import type { Confirm } from "../chrome/ConfirmDialog";
import { Kbd } from "../chrome/Kbd";
import { Button, Select, Toggle, type Option } from "../chrome/kit";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useBotAvatar } from "../hooks/useBotAvatar";
import { useBrowserPrefs } from "../hooks/useBrowserPrefs";
import { useColorMode } from "../hooks/useColorMode";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { changeSitePermissions, useSitePermissions } from "../hooks/useSitePermissions";
import { useTabScope } from "../hooks/useTabScope";
import { BOT_AVATARS } from "../lib/botAvatar";
import { KEEP_CHOICES, SEARCH_ENGINES } from "../lib/browserPrefs";
import { forget, PERMISSION_LABELS, SITE_PERMISSIONS } from "../lib/browser/permissions";
import { COLOR_MODES } from "../lib/colorMode";
import { describeCli, type CliResult, type CliStatus } from "../lib/cli";
import { bindingGroups } from "../lib/commandGroups";
import { BROWSER_CLICK } from "../lib/external";
import { cliHost } from "../lib/host";
import { PROVIDERS } from "../lib/providers";
import { settingsSection, type SettingsSectionId } from "../lib/settings";
import type { Workspace } from "../lib/types";
import type { TabScope } from "../lib/worktrees";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { NotificationSettings } from "./NotificationSettings";
import { SessionSettings } from "./SessionSettings";
import { TerminalSettings } from "./TerminalSettings";
import { useRedesign } from "../prototype/design-system/direction";

// PROTOTYPE — throwaway: with a redesign direction on (dev only), the redesigned pages stand in.
const RedesignedSettingsPage = lazy(() =>
  import("../prototype/design-system/settings/SettingsPages").then((m) => ({ default: m.RedesignedSettingsPage })),
);

const TAB_SCOPES: Option<TabScope>[] = [
  { value: "worktree", label: "Per worktree" },
  { value: "all", label: "All together" },
];

type Props = {
  section: SettingsSectionId;
  workspaces: Workspace[];
  onConfirm: (confirm: Confirm) => void;
  onOpenTerminal: (envId: string) => Promise<void>;
};

export function SettingsView(props: Props) {
  const redesign = useRedesign();
  return redesign ? <RedesignedSettings {...props} /> : <ClassicSettingsView {...props} />;
}

/** PROTOTYPE — throwaway: the redesign's page for the section, fed the real installed CLIs. */
function RedesignedSettings({ section, workspaces, onOpenTerminal }: Props) {
  const { installed } = useDefaultAgent();
  return (
    <Suspense fallback={<div className="h-full" />}>
      <RedesignedSettingsPage
        section={section}
        workspaces={workspaces}
        onOpenTerminal={onOpenTerminal}
        installed={installed.map((provider) => provider.id)}
      />
    </Suspense>
  );
}

function ClassicSettingsView({ section, workspaces, onConfirm, onOpenTerminal }: Props) {
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
          {section === "notifications" && <NotificationSettings />}
          {section === "keybindings" && <Keybindings />}
          {section === "terminal" && <TerminalSettings />}
          {section === "browser" && <BrowserSettings />}
          {section === "environments" && <EnvironmentSettings workspaces={workspaces} onOpenTerminal={onOpenTerminal} />}
          {section === "providers" && <Providers />}
          {section !== "general" &&
            section !== "appearance" &&
            section !== "notifications" &&
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
  return (
    <>
      <SettingsSection title="Worktrees">
        <SettingsRow
          label="Tabs"
          description="Tabs per worktree, or one strip for all, marked by branch."
        >
          <Select label="Tabs" className="w-40" value={tabs.scope} onChange={tabs.update} options={TAB_SCOPES} />
        </SettingsRow>
      </SettingsSection>
      <SessionSettings onConfirm={onConfirm} />
      <CommandLineSettings />
    </>
  );
}

/** The `crew` command for the user's own terminal. Only in the app: a browser has no PATH to link into. */
function CommandLineSettings() {
  const host = cliHost();
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    host
      ?.status()
      .then((next) => !cancelled && setStatus(next))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (!host || !status) return null;
  const act = (run: () => Promise<CliResult>) => {
    setBusy(true);
    setError(null);
    run()
      .then((result) => {
        setStatus(result.status);
        setError(result.error ?? null);
      })
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsSection title="Command line">
      <SettingsRow label="crew command" description={error ?? describeCli(status)}>
        {status.state === "installed" ? (
          <Button variant="ghost" className="h-7 text-[12px]" loading={busy} onClick={() => act(() => host.uninstall())}>
            Uninstall
          </Button>
        ) : (
          <Button
            className="h-7 text-[12px]"
            loading={busy}
            disabled={status.state === "unavailable"}
            onClick={() => act(() => host.install())}
          >
            Install
          </Button>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

const PREVIEW_SEEDS = ["crew", "scout", "atlas", "pilot"];

function Appearance() {
  const avatar = useBotAvatar();
  const color = useColorMode();
  return (
    <>
      {color.available && (
        <SettingsSection title="Theme">
          <SettingsRow label="Mode" description="System follows macOS.">
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
      <SettingsSection title="Bots">
        <SettingsRow label="Avatar style" description="Each bot gets a unique face in this style.">
          <div className="flex items-center gap-3">
            <div className="flex gap-1" aria-hidden>
              {PREVIEW_SEEDS.map((seed) => (
                <BotAvatar key={seed} seed={seed} bare className="size-6" />
              ))}
            </div>
            <Select
              label="Avatar style"
              className="w-40"
              value={avatar.avatar}
              onChange={avatar.update}
              options={BOT_AVATARS.map((item) => ({ value: item.id, label: item.label }))}
            />
          </div>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

export function BrowserSettings() {
  const { prefs, update } = useBrowserPrefs();
  return (
    <>
      <SettingsSection title="Links">
        <Toggle
          label="Open links in Crew"
          description={
            prefs.openLinksInCrew
              ? `Chat and terminal links open here. ${BROWSER_CLICK}-click for your browser.`
              : "Chat and terminal links open in your browser."
          }
          checked={prefs.openLinksInCrew}
          onChange={(checked) => update({ ...prefs, openLinksInCrew: checked })}
        />
      </SettingsSection>
      <SettingsSection title="Pages">
        <SettingsRow label="Search engine" description="For address bar searches.">
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
          description="Hidden tabs kept loaded. Others reload when shown."
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
              : "Saves to Downloads. Right-click a link to choose."
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
          No site permissions saved.
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
  const { installed } = useDefaultAgent();
  return (
    <>
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

/** Every binding, grouped the way the app is: tabs, places, bots, finding, view. */
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
      {groups.length === 0 && <p className="px-2.5 text-text-muted">No results for “{query}”</p>}
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
      <p className="py-4 text-text-muted">{label}: not built yet.</p>
    </SettingsSection>
  );
}
