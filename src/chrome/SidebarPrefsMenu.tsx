import { Menu } from "@base-ui/react/menu";
import { ALargeSmallIcon, ArrowUpDownIcon, BotIcon, CheckIcon, ChevronRightIcon, CircleDashedIcon, ClockIcon, EyeIcon, GitBranchIcon, GitCompareArrowsIcon, HandGrabIcon, LayersIcon, ListFilterIcon, ShapesIcon, SquareTerminalIcon, type LucideIcon as Icon } from "lucide-react";
import type { ReactNode } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { PROVIDERS } from "../lib/providers";
import {
  DEFAULT_PREFS,
  isDefault,
  toggle,
  type Detail,
  type Ordering,
  type Scope,
  type SidebarPrefs,
} from "../lib/sidebarPrefs";
import type { SessionKind } from "../lib/types";

const SCOPES: { id: Scope; label: string; icon: Icon }[] = [
  { id: "all", label: "All worktrees", icon: LayersIcon },
  { id: "current", label: "Current only", icon: GitBranchIcon },
  { id: "busy", label: "With activity", icon: CircleDashedIcon },
];

const ORDERINGS: { id: Ordering; label: string; icon: Icon }[] = [
  { id: "manual", label: "Manual", icon: HandGrabIcon },
  { id: "updated", label: "Updated", icon: ClockIcon },
  { id: "name", label: "Name", icon: ALargeSmallIcon },
];

const DETAILS: { id: Detail; label: string; icon: Icon }[] = [
  { id: "names", label: "Agent names", icon: ALargeSmallIcon },
  { id: "diff", label: "Diff stats", icon: GitCompareArrowsIcon },
  { id: "status", label: "Status", icon: CircleDashedIcon },
  { id: "updated", label: "Updated", icon: ClockIcon },
];

const KINDS: { id: SessionKind; label: string; icon: Icon }[] = [
  { id: "agent", label: "Agents", icon: BotIcon },
  { id: "terminal", label: "Sessions", icon: SquareTerminalIcon },
];

const PANEL =
  "max-h-[70vh] w-56 origin-(--transform-origin) overflow-y-auto overscroll-none rounded-xl bg-surface p-1 text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

const ROW =
  "flex h-8 w-full cursor-default items-center gap-2 whitespace-nowrap rounded-md px-2 text-left outline-none select-none data-highlighted:bg-hover data-popup-open:bg-hover";

/** Submenus open beside their trigger, so they overlap the parent by the popup's own padding. */
function submenuOffset({ side }: { side: Menu.Positioner.Props["side"] }) {
  return side === "top" || side === "bottom" ? 4 : -4;
}

type Props = {
  prefs: SidebarPrefs;
  onChange: (prefs: SidebarPrefs) => void;
};

/** The panel's view menu: ordering and detail, then filters. Every row carries its icon. */
export function SidebarPrefsMenu({ prefs, onChange }: Props) {
  const dirty = !isDefault(prefs);
  const ordering = ORDERINGS.find((item) => item.id === prefs.ordering);
  const scope = SCOPES.find((item) => item.id === prefs.scope);

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label="Customize sidebar"
        title="Customize sidebar"
        data-tauri-drag-region="false"
        className={`relative grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors hover:bg-hover hover:text-text data-popup-open:bg-hover data-popup-open:text-text ${
          dirty ? "text-text" : "text-text-muted"
        }`}
      >
        <ListFilterIcon className="size-4" />
        {dirty && (
          <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-text ring-2 ring-surface" />
        )}
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner
          side="right"
          align="start"
          sideOffset={4}
          collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
          className="z-50"
        >
          <Menu.Popup className={PANEL}>
            <Submenu icon={LayersIcon} label="Worktrees" value={scope?.label}>
              <Menu.RadioGroup
                value={prefs.scope}
                onValueChange={(value) => onChange({ ...prefs, scope: value as Scope })}
              >
                {SCOPES.map((item) => (
                  <Menu.RadioItem key={item.id} value={item.id} className={ROW}>
                    <item.icon className="size-4 shrink-0 text-icon" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <Menu.RadioItemIndicator>
                      <CheckIcon className="size-4 shrink-0" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Submenu>

            <Submenu icon={ArrowUpDownIcon} label="Ordering" value={ordering?.label}>
              <Menu.RadioGroup
                value={prefs.ordering}
                onValueChange={(value) => onChange({ ...prefs, ordering: value as Ordering })}
              >
                {ORDERINGS.map((item) => (
                  <Menu.RadioItem key={item.id} value={item.id} className={ROW}>
                    <item.icon className="size-4 shrink-0 text-icon" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <Menu.RadioItemIndicator>
                      <CheckIcon className="size-4 shrink-0" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Submenu>

            <Submenu icon={EyeIcon} label="Show">
              {DETAILS.map((item) => (
                <Check
                  key={item.id}
                  label={item.label}
                  icon={<item.icon className="size-4 shrink-0 text-icon" />}
                  checked={prefs.show.includes(item.id)}
                  onChange={() => onChange({ ...prefs, show: toggle(prefs.show, item.id) })}
                />
              ))}
            </Submenu>

            <Separator />

            <div className="flex h-8 items-center justify-between pr-1 pl-2 text-text-muted">
              <span>Filters</span>
              <Menu.Item
                closeOnClick={false}
                disabled={!dirty}
                onClick={() => onChange(DEFAULT_PREFS)}
                className="cursor-default rounded-md px-1.5 py-0.5 outline-none select-none data-disabled:opacity-40 data-highlighted:bg-hover data-highlighted:text-text"
              >
                Reset
              </Menu.Item>
            </div>

            <Submenu icon={ShapesIcon} label="Kind" active={prefs.hiddenKinds.length > 0}>
              {KINDS.map((item) => (
                <Check
                  key={item.id}
                  label={item.label}
                  icon={<item.icon className="size-4 shrink-0 text-icon" />}
                  checked={!prefs.hiddenKinds.includes(item.id)}
                  onChange={() =>
                    onChange({ ...prefs, hiddenKinds: toggle(prefs.hiddenKinds, item.id) })
                  }
                />
              ))}
            </Submenu>

            <Submenu icon={BotIcon} label="Provider" active={prefs.hiddenProviders.length > 0}>
              {PROVIDERS.map((provider) => (
                <Check
                  key={provider.id}
                  label={provider.label}
                  icon={<ProviderIcon provider={provider.id} className="size-4 shrink-0" />}
                  checked={!prefs.hiddenProviders.includes(provider.id)}
                  onChange={() =>
                    onChange({
                      ...prefs,
                      hiddenProviders: toggle(prefs.hiddenProviders, provider.id),
                    })
                  }
                />
              ))}
            </Submenu>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Separator() {
  return <Menu.Separator className="mx-2 my-1 h-px bg-border" />;
}

function Submenu({
  icon: Glyph,
  label,
  value,
  active = false,
  children,
}: {
  icon: Icon;
  label: string;
  value?: string | undefined;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={ROW}>
        <Glyph className="size-4 shrink-0 text-icon" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {value && <span className="shrink-0 text-text-muted">{value}</span>}
        {active && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current text-text-muted" />}
        <ChevronRightIcon className="size-3.5 shrink-0 text-icon" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner
          className="z-50"
          sideOffset={submenuOffset}
          alignOffset={submenuOffset}
        >
          <Menu.Popup className={PANEL}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

function Check({
  label,
  icon,
  checked,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <Menu.CheckboxItem checked={checked} onCheckedChange={onChange} className={ROW}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Menu.CheckboxItemIndicator>
        <CheckIcon className="size-4 shrink-0" />
      </Menu.CheckboxItemIndicator>
    </Menu.CheckboxItem>
  );
}
