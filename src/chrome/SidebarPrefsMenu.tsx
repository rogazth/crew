import { Menu } from "@base-ui/react/menu";
import {
  CaretRightIcon,
  CheckIcon,
  CircleDashedIcon,
  ClockIcon,
  ProhibitIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  TextAaIcon,
  UserCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { PROVIDERS } from "../lib/providers";
import {
  DEFAULT_PREFS,
  isDefault,
  toggle,
  type Detail,
  type Grouping,
  type Ordering,
  type SidebarPrefs,
} from "../lib/sidebarPrefs";
import type { SessionKind } from "../lib/types";

const GROUPINGS: { id: Grouping; label: string; icon: Icon }[] = [
  { id: "none", label: "None", icon: ProhibitIcon },
  { id: "kind", label: "Kind", icon: SquaresFourIcon },
  { id: "provider", label: "Provider", icon: RobotIcon },
  { id: "status", label: "Status", icon: CircleDashedIcon },
];

const ORDERINGS: { id: Ordering; label: string; icon: Icon }[] = [
  { id: "manual", label: "Manual", icon: SquaresFourIcon },
  { id: "updated", label: "Updated", icon: ClockIcon },
  { id: "name", label: "Name", icon: TextAaIcon },
];

const DETAILS: { id: Detail; label: string; icon: Icon }[] = [
  { id: "avatar", label: "Avatar", icon: UserCircleIcon },
  { id: "provider", label: "Provider", icon: RobotIcon },
  { id: "status", label: "Status", icon: CircleDashedIcon },
  { id: "updated", label: "Updated", icon: ClockIcon },
];

const KINDS: { id: SessionKind; label: string }[] = [
  { id: "agent", label: "Agents" },
  { id: "terminal", label: "Sessions" },
];

const PANEL =
  "max-h-[70vh] w-56 origin-(--transform-origin) overflow-y-auto overscroll-none rounded-xl bg-kumo-control p-1 text-kumo-default shadow-lg ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

const ROW =
  "flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-left outline-none select-none data-highlighted:bg-hover data-popup-open:bg-hover";

/** Submenus open beside their trigger, so they overlap the parent by the popup's own padding. */
function submenuOffset({ side }: { side: Menu.Positioner.Props["side"] }) {
  return side === "top" || side === "bottom" ? 4 : -4;
}

type Props = {
  prefs: SidebarPrefs;
  onChange: (prefs: SidebarPrefs) => void;
};

/** Cursor's sidebar preferences, cut to what crew has: grouping, ordering, detail, filters. */
export function SidebarPrefsMenu({ prefs, onChange }: Props) {
  const dirty = !isDefault(prefs);
  const grouping = GROUPINGS.find((item) => item.id === prefs.grouping);

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label="Customize sidebar"
        title="Customize sidebar"
        data-tauri-drag-region="false"
        className={`relative grid size-8 shrink-0 place-items-center rounded-md outline-none transition-colors hover:bg-hover hover:text-kumo-default data-popup-open:bg-hover data-popup-open:text-kumo-default ${
          dirty ? "text-kumo-default" : "text-kumo-subtle"
        }`}
      >
        <SlidersHorizontalIcon className="size-4" />
        {dirty && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-kumo-default" />}
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            <Submenu label="Grouping" value={grouping?.label}>
              <Menu.RadioGroup
                value={prefs.grouping}
                onValueChange={(value) => onChange({ ...prefs, grouping: value as Grouping })}
              >
                {GROUPINGS.map((item) => (
                  <Menu.RadioItem key={item.id} value={item.id} className={ROW}>
                    <item.icon className="size-4 shrink-0 text-kumo-subtle" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <Menu.RadioItemIndicator>
                      <CheckIcon className="size-4 shrink-0" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Submenu>

            <Submenu label="Ordering">
              <Menu.RadioGroup
                value={prefs.ordering}
                onValueChange={(value) => onChange({ ...prefs, ordering: value as Ordering })}
              >
                {ORDERINGS.map((item) => (
                  <Menu.RadioItem key={item.id} value={item.id} className={ROW}>
                    <item.icon className="size-4 shrink-0 text-kumo-subtle" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <Menu.RadioItemIndicator>
                      <CheckIcon className="size-4 shrink-0" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Submenu>

            <Submenu label="Show">
              {DETAILS.map((item) => (
                <Check
                  key={item.id}
                  label={item.label}
                  icon={<item.icon className="size-4 shrink-0 text-kumo-subtle" />}
                  checked={prefs.show.includes(item.id)}
                  onChange={() => onChange({ ...prefs, show: toggle(prefs.show, item.id) })}
                />
              ))}
            </Submenu>

            <Separator />

            <div className="flex h-8 items-center justify-between pr-1 pl-2 text-kumo-subtle">
              <span>Filters</span>
              <Menu.Item
                closeOnClick={false}
                disabled={!dirty}
                onClick={() => onChange(DEFAULT_PREFS)}
                className="cursor-default rounded-md px-1.5 py-0.5 outline-none select-none data-disabled:opacity-40 data-highlighted:bg-hover data-highlighted:text-kumo-default"
              >
                Reset
              </Menu.Item>
            </div>

            <Submenu label="Kind" active={prefs.hiddenKinds.length > 0}>
              {KINDS.map((item) => (
                <Check
                  key={item.id}
                  label={item.label}
                  checked={!prefs.hiddenKinds.includes(item.id)}
                  onChange={() =>
                    onChange({ ...prefs, hiddenKinds: toggle(prefs.hiddenKinds, item.id) })
                  }
                />
              ))}
            </Submenu>

            <Submenu label="Provider" active={prefs.hiddenProviders.length > 0}>
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
  return <Menu.Separator className="mx-2 my-1 h-px bg-kumo-line" />;
}

function Submenu({
  label,
  value,
  active = false,
  children,
}: {
  label: string;
  value?: string | undefined;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={ROW}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {value && <span className="shrink-0 text-kumo-subtle">{value}</span>}
        {active && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current text-kumo-subtle" />}
        <CaretRightIcon className="size-3.5 shrink-0 text-kumo-subtle" />
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
