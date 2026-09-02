import { Popover } from "@base-ui/react/popover";
import { CheckIcon, FunnelSimpleIcon } from "@phosphor-icons/react";
import { ProviderIcon } from "./ProviderIcon";
import { PROVIDERS } from "../lib/providers";
import { hasFilters, toggle, type SessionFilters } from "../lib/sessionFilters";
import type { SessionKind } from "../lib/types";

const KINDS: { id: SessionKind; label: string }[] = [
  { id: "agent", label: "Agents" },
  { id: "terminal", label: "Sessions" },
];

type Props = {
  filters: SessionFilters;
  onChange: (filters: SessionFilters) => void;
};

/** R1's session filter menu, cut to what crew actually has: kind and provider. */
export function SessionFiltersMenu({ filters, onChange }: Props) {
  const active = hasFilters(filters);

  return (
    <Popover.Root modal={false}>
      <Popover.Trigger
        aria-label="Filter sessions"
        title="Filter sessions"
        data-tauri-drag-region="false"
        className={`grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors hover:bg-kumo-tint hover:text-kumo-default data-popup-open:bg-kumo-tint data-popup-open:text-kumo-default ${
          active ? "bg-kumo-tint text-kumo-default" : "text-kumo-subtle"
        }`}
      >
        <FunnelSimpleIcon className="size-3.5" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Popover.Popup className="w-52 origin-(--transform-origin) rounded-lg bg-kumo-control p-1 text-kumo-default shadow-lg ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
            <Label>Show</Label>
            {KINDS.map((kind) => (
              <Item
                key={kind.id}
                label={kind.label}
                checked={!filters.hiddenKinds.includes(kind.id)}
                onClick={() =>
                  onChange({ ...filters, hiddenKinds: toggle(filters.hiddenKinds, kind.id) })
                }
              />
            ))}

            <Label>Provider</Label>
            {PROVIDERS.map((provider) => (
              <Item
                key={provider.id}
                label={provider.label}
                icon={<ProviderIcon provider={provider.id} className="size-3.5 shrink-0" />}
                checked={!filters.hiddenProviders.includes(provider.id)}
                onClick={() =>
                  onChange({
                    ...filters,
                    hiddenProviders: toggle(filters.hiddenProviders, provider.id),
                  })
                }
              />
            ))}

            {active && (
              <>
                <div className="my-1 h-px bg-kumo-line" />
                <button
                  type="button"
                  onClick={() => onChange({ hiddenKinds: [], hiddenProviders: [] })}
                  className="flex h-7 w-full items-center rounded-md px-2 text-left text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
                >
                  Clear filters
                </button>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Label({ children }: { children: string }) {
  return (
    <p className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-kumo-subtle uppercase">
      {children}
    </p>
  );
}

function Item({
  label,
  checked,
  icon,
  onClick,
}: {
  label: string;
  checked: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-kumo-tint"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <CheckIcon className="size-3.5 shrink-0" />}
    </button>
  );
}
