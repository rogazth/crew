import { PROVIDERS, type SessionKind } from "@crew/fixtures";
import { useStore, type Grouping, type Ordering } from "@/lib/store";
import { IconButton } from "@/ui/Button";
import { MenuCheckItem, MenuLabel, MenuRadioGroup, MenuRoot, MenuSep } from "@/ui/Menu";

const GROUPING: ReadonlyArray<{ value: Grouping; label: string }> = [
  { value: "none", label: "None" },
  { value: "kind", label: "Kind" },
  { value: "provider", label: "Provider" },
  { value: "status", label: "Status" },
];

const ORDERING: ReadonlyArray<{ value: Ordering; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "updated", label: "Last updated" },
  { value: "name", label: "Name" },
];

const KINDS: Array<{ kind: SessionKind; label: string }> = [
  { kind: "agent", label: "Agents" },
  { kind: "terminal", label: "Terminals" },
];

/** Lives inside the search field, where the list's own settings belong. */
export function SidebarPrefsMenu() {
  const { prefs, setPrefs } = useStore();

  const toggleShow = (key: keyof typeof prefs.show) => (next: boolean) =>
    setPrefs({ ...prefs, show: { ...prefs.show, [key]: next } });

  return (
    <MenuRoot
      align="end"
      trigger={<IconButton icon="filter" label="List preferences" size="sm" variant="ghost" className="-mr-1" />}
    >
      <MenuLabel>Group by</MenuLabel>
      <MenuRadioGroup value={prefs.grouping} onChange={(grouping) => setPrefs({ ...prefs, grouping })} options={GROUPING} />
      <MenuSep />
      <MenuLabel>Order by</MenuLabel>
      <MenuRadioGroup value={prefs.ordering} onChange={(ordering) => setPrefs({ ...prefs, ordering })} options={ORDERING} />
      <MenuSep />
      <MenuLabel>Show</MenuLabel>
      <MenuCheckItem checked={prefs.show.avatar} onChange={toggleShow("avatar")}>
        Avatar
      </MenuCheckItem>
      <MenuCheckItem checked={prefs.show.provider} onChange={toggleShow("provider")}>
        Provider and model
      </MenuCheckItem>
      <MenuCheckItem checked={prefs.show.updated} onChange={toggleShow("updated")}>
        Last updated
      </MenuCheckItem>
      <MenuCheckItem checked={prefs.show.status} onChange={toggleShow("status")}>
        Status
      </MenuCheckItem>
      <MenuSep />
      <MenuLabel>Hide kinds</MenuLabel>
      {KINDS.map(({ kind, label }) => (
        <MenuCheckItem
          key={kind}
          checked={prefs.hideKinds.includes(kind)}
          onChange={(next) =>
            setPrefs({
              ...prefs,
              hideKinds: next ? [...prefs.hideKinds, kind] : prefs.hideKinds.filter((k) => k !== kind),
            })
          }
        >
          {label}
        </MenuCheckItem>
      ))}
      <MenuSep />
      <MenuLabel>Hide providers</MenuLabel>
      {PROVIDERS.map((provider) => (
        <MenuCheckItem
          key={provider.id}
          checked={prefs.hideProviders.includes(provider.id)}
          onChange={(next) =>
            setPrefs({
              ...prefs,
              hideProviders: next
                ? [...prefs.hideProviders, provider.id]
                : prefs.hideProviders.filter((p) => p !== provider.id),
            })
          }
        >
          {provider.label}
        </MenuCheckItem>
      ))}
    </MenuRoot>
  );
}
