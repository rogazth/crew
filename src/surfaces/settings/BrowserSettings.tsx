import { Button, Select, Toggle, type Option } from "../../chrome/kit";
import { SettingsRow, SettingsSection } from "../../chrome/SettingsRow";
import { useBrowserPrefs } from "../../hooks/useBrowserPrefs";
import { changeSitePermissions, useSitePermissions } from "../../hooks/useSitePermissions";
import { KEEP_CHOICES, SEARCH_ENGINES } from "../../lib/browserPrefs";
import { forget, PERMISSION_LABELS, SITE_PERMISSIONS } from "../../lib/browser/permissions";
import { BROWSER_CLICK } from "../../lib/external";

export function BrowserSettings() {
  const { prefs, update } = useBrowserPrefs();
  return (
    <>
      <SettingsSection title="Links">
        <div data-setting="links-in-crew">
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
        </div>
      </SettingsSection>
      <SettingsSection title="Pages">
        <SettingsRow id="search-engine" label="Search engine" description="For address bar searches.">
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
    <SettingsSection id="site-permissions" title="Site permissions">
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
