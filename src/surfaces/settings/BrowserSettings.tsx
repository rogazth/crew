import { Select, type Option } from "../../chrome/kit";
import { useBrowserPrefs } from "../../hooks/useBrowserPrefs";
import { changeSitePermissions, useSitePermissions } from "../../hooks/useSitePermissions";
import { SEARCH_ENGINES } from "../../lib/browserPrefs";
import { decide, forget, PERMISSION_LABELS, SITE_PERMISSIONS, type SiteDecision, type SitePermission } from "../../lib/browser/permissions";
import { SiteIcon } from "../chat/SiteIcon";
import { RowAction } from "./integrations/bits";
import { Group, Row } from "./ui";

export function BrowserSettings() {
  const { prefs, update } = useBrowserPrefs();
  return (
    <>
      <Group>
        <Row id="search-engine" label="Search engine" description="For address bar searches.">
          <Select
            label="Search engine"
            className="w-40"
            value={prefs.searchTemplate}
            onChange={(searchTemplate) => update({ ...prefs, searchTemplate })}
            options={SEARCH_ENGINES.map((engine): Option<string> => ({ value: engine.template, label: engine.label }))}
          />
        </Row>
      </Group>
      <SitePermissionsSettings />
    </>
  );
}

/** Every site with a decision kept: each thing it may or may not use, to change there, and a way to start over. */
function SitePermissionsSettings() {
  const decisions = useSitePermissions();
  const sites = Object.keys(decisions).sort((a, b) => a.localeCompare(b));
  return (
    <Group id="site-permissions" title="Site permissions">
      {sites.length === 0 ? (
        <p className="py-3 text-text-muted">No site permissions saved.</p>
      ) : (
        sites.map((site) => <SiteRow key={site} site={site} decided={decisions[site] ?? {}} />)
      )}
    </Group>
  );
}

const CHOICES: Option<SiteDecision>[] = [
  { value: "allow", label: "Allow" },
  { value: "block", label: "Block" },
];

function SiteRow({ site, decided }: { site: string; decided: Partial<Record<SitePermission, SiteDecision>> }) {
  const name = site.replace(/^https:\/\//, "");
  const kinds = SITE_PERMISSIONS.filter((kind) => decided[kind]);
  return (
    <div className="py-2">
      <div className="flex min-h-8 items-center gap-2.5">
        <span className="grid size-4 shrink-0 place-items-center [&_.crew-site-icon]:size-4">
          <SiteIcon url={site} />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium" data-selectable>
          {name}
        </span>
        <RowAction label="Reset" onClick={() => void changeSitePermissions((current) => forget(current, site))} />
      </div>
      <div className="flex flex-col pl-[26px]">
        {kinds.map((kind) => (
          <div key={kind} className="flex min-h-8 items-center justify-between gap-3">
            <span className="truncate text-text-muted">{PERMISSION_LABELS[kind].name}</span>
            <Select<SiteDecision>
              variant="row"
              label={`${PERMISSION_LABELS[kind].name} on ${name}`}
              value={decided[kind] ?? "block"}
              options={CHOICES}
              onChange={(next) => void changeSitePermissions((current) => decide(current, site, [kind], next))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
