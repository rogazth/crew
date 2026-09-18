import { useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { PROVIDERS } from "@crew/fixtures";
import { Menu, type MenuItem } from "@/ui";
import { store, useApp } from "@/lib/store";
import type { Grouping, Ordering, ShowKey } from "@/lib/prefs";

const GROUPING: Array<{ id: Grouping; label: string }> = [
  { id: "none", label: "No grouping" },
  { id: "kind", label: "Group by kind" },
  { id: "provider", label: "Group by provider" },
  { id: "status", label: "Group by status" },
  { id: "lineage", label: "Group by lineage" },
];

const ORDERING: Array<{ id: Ordering; label: string }> = [
  { id: "manual", label: "Manual" },
  { id: "updated", label: "Last updated" },
  { id: "name", label: "Name" },
];

const SHOW: Array<{ id: ShowKey; label: string }> = [
  { id: "avatar", label: "Avatar" },
  { id: "provider", label: "Provider and model" },
  { id: "updated", label: "Elapsed" },
  { id: "status", label: "Status" },
];

/** The preferences menu lives inside the search field, as in the app. */
export function SidebarPrefsButton() {
  const state = useApp();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { prefs } = state;

  const items: MenuItem[] = [
    { kind: "label", id: "l-group", label: "Grouping" },
    ...GROUPING.map((option) => ({
      id: `g-${option.id}`,
      label: option.label,
      checked: prefs.grouping === option.id,
      onSelect: () => store.setPrefs({ grouping: option.id }),
    })),
    { kind: "separator", id: "s1" },
    { kind: "label", id: "l-order", label: "Ordering" },
    ...ORDERING.map((option) => ({
      id: `o-${option.id}`,
      label: option.label,
      checked: prefs.ordering === option.id,
      onSelect: () => store.setPrefs({ ordering: option.id }),
    })),
    { kind: "separator", id: "s2" },
    { kind: "label", id: "l-show", label: "Show" },
    ...SHOW.map((option) => ({
      id: `s-${option.id}`,
      label: option.label,
      checked: prefs.show[option.id],
      onSelect: () => store.setPrefs({ show: { ...prefs.show, [option.id]: !prefs.show[option.id] } }),
    })),
    { kind: "separator", id: "s3" },
    { kind: "label", id: "l-hide", label: "Hide" },
    ...(["agent", "terminal"] as const).map((kind) => ({
      id: `k-${kind}`,
      label: kind === "agent" ? "Agents" : "Terminals",
      checked: !prefs.hiddenKinds.includes(kind),
      onSelect: () =>
        store.setPrefs({
          hiddenKinds: prefs.hiddenKinds.includes(kind)
            ? prefs.hiddenKinds.filter((x) => x !== kind)
            : [...prefs.hiddenKinds, kind],
        }),
    })),
    ...PROVIDERS.map((provider) => ({
      id: `p-${provider.id}`,
      label: provider.label,
      checked: !prefs.hiddenProviders.includes(provider.id),
      onSelect: () =>
        store.setPrefs({
          hiddenProviders: prefs.hiddenProviders.includes(provider.id)
            ? prefs.hiddenProviders.filter((x) => x !== provider.id)
            : [...prefs.hiddenProviders, provider.id],
        }),
    })),
  ];

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label="List preferences"
        title="List preferences"
        onClick={() => setOpen((held) => !held)}
        className="grid size-4 shrink-0 place-items-center text-ink-4 hover:text-ink"
      >
        <SlidersHorizontal size={13} strokeWidth={1.25} />
      </button>
      <Menu
        open={open}
        anchor={ref.current}
        onClose={() => setOpen(false)}
        items={items}
        align="end"
        label="List preferences"
        width={240}
      />
    </>
  );
}
