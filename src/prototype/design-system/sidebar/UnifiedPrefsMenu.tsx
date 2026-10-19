// PROTOTYPE — throwaway. The sessions' view menu: how they are grouped, what
// a line shows, and which ones are listed. It never touches the bots: their
// names, status and order are their own. Which worktrees the sessions come
// from stands in for "current only", since no worktree is current any more.
import { Menu } from "@base-ui/react/menu";
import {
  ALargeSmallIcon,
  ArrowUpDownIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ClockIcon,
  EyeIcon,
  FolderIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  HandGrabIcon,
  LayoutListIcon,
  ListFilterIcon,
  ListOrderedIcon,
  RowsIcon,
  type LucideIcon as Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { PROVIDERS } from "../../../lib/providers";
import { DEFAULT_PREFS, LIMITS, toggle, type Detail, type Limit, type Ordering, type Recency, type SidebarPrefs } from "../../../lib/sidebarPrefs";
import type { Worktree } from "../../../lib/types";
import { worktreeLabel } from "../../../lib/worktrees";

/** How the sessions are laid out; each says on a session's second line only what its group does not. */
export type Grouping = "none" | "worktree" | "status";

/** Sessions under their worktree until the view menu says otherwise. */
export const DEFAULT_GROUPING: Grouping = "worktree";

const GROUPINGS: { id: Grouping; label: string; hint: string; icon: Icon }[] = [
  { id: "none", label: "None", hint: "Two lines, worktree under the name", icon: RowsIcon },
  { id: "worktree", label: "Worktree", hint: "One line, under each worktree", icon: GitBranchIcon },
  { id: "status", label: "Status", hint: "Two lines, by what needs you", icon: CircleDashedIcon },
];

const ORDERINGS: { id: Ordering; label: string; icon: Icon }[] = [
  { id: "manual", label: "Manual", icon: HandGrabIcon },
  { id: "updated", label: "Updated", icon: ClockIcon },
  { id: "name", label: "Name", icon: ALargeSmallIcon },
];

const RECENCIES: { id: Recency; label: string; short: string }[] = [
  { id: "any", label: "Any time", short: "Any time" },
  { id: "day", label: "Last 24 hours", short: "24h" },
  { id: "3days", label: "Last 3 days", short: "3 days" },
  { id: "week", label: "Last week", short: "Week" },
];

const limitLabel = (limit: Limit) => (limit === 0 ? "No limit" : String(limit));

const DETAILS: { id: Detail; label: string; icon: Icon }[] = [
  { id: "status", label: "Status", icon: CircleDashedIcon },
  { id: "updated", label: "Updated", icon: ClockIcon },
  { id: "diff", label: "Diff stats", icon: GitCompareArrowsIcon },
];

const PANEL =
  "max-h-[70vh] w-56 origin-(--transform-origin) overflow-y-auto overscroll-none rounded-xl bg-surface p-1 text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

const ROW =
  "flex h-8 w-full cursor-default items-center gap-2 whitespace-nowrap rounded-md px-2 text-left outline-none select-none data-highlighted:bg-hover data-popup-open:bg-hover";

function submenuOffset({ side }: { side: Menu.Positioner.Props["side"] }) {
  return side === "top" || side === "bottom" ? 4 : -4;
}

type Props = {
  prefs: SidebarPrefs;
  onChange: (prefs: SidebarPrefs) => void;
  grouping: Grouping;
  onGrouping: (grouping: Grouping) => void;
  worktrees: Worktree[];
  /** Worktrees whose sessions are left out, by path. */
  hiddenTrees: string[];
  onHiddenTrees: (paths: string[]) => void;
  /** A session's worktree under its name; hidden, the line is one line. */
  showWorktree: boolean;
  onShowWorktree: (show: boolean) => void;
};

export function UnifiedPrefsMenu({ prefs, onChange, grouping, onGrouping, worktrees, hiddenTrees, onHiddenTrees, showWorktree, onShowWorktree }: Props) {
  const filtered = prefs.recency !== DEFAULT_PREFS.recency || prefs.limit !== DEFAULT_PREFS.limit || prefs.hiddenProviders.length > 0 || hiddenTrees.length > 0;
  const dirty = filtered || (worktrees.length > 0 && grouping !== DEFAULT_GROUPING) || prefs.ordering !== DEFAULT_PREFS.ordering;
  const group = GROUPINGS.find((item) => item.id === grouping);
  const ordering = ORDERINGS.find((item) => item.id === prefs.ordering);
  const recency = RECENCIES.find((item) => item.id === prefs.recency);

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label="Customize sidebar"
        title="Customize sidebar"
        data-tauri-drag-region="false"
        className={`relative grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors hover:bg-hover hover:text-text data-popup-open:bg-hover data-popup-open:text-text ${
          dirty ? "text-text" : "text-icon"
        }`}
      >
        <ListFilterIcon className="size-4" />
        {dirty && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-text ring-2 ring-sidebar" />}
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner side="right" align="start" sideOffset={4} collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }} className="z-50">
          <Menu.Popup className={PANEL}>
            <Submenu icon={LayoutListIcon} label="Group by" value={group?.label}>
              <Menu.RadioGroup value={grouping} onValueChange={(value) => onGrouping(value as Grouping)}>
                {GROUPINGS.map((item) => (
                  <Menu.RadioItem key={item.id} value={item.id} className={`${ROW} h-auto py-1.5`}>
                    <item.icon className="size-4 shrink-0 self-start text-icon" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{item.label}</span>
                      <span className="truncate text-[11px] text-text-muted">{item.hint}</span>
                    </span>
                    <Menu.RadioItemIndicator>
                      <CheckIcon className="size-4 shrink-0" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Submenu>

            <Submenu icon={ArrowUpDownIcon} label="Ordering" value={ordering?.label}>
              <Menu.RadioGroup value={prefs.ordering} onValueChange={(value) => onChange({ ...prefs, ordering: value as Ordering })}>
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
              {grouping !== "worktree" && (
                <Check
                  label="Worktree"
                  icon={<GitBranchIcon className="size-4 shrink-0 text-icon" />}
                  checked={showWorktree}
                  onChange={() => onShowWorktree(!showWorktree)}
                />
              )}
              {DETAILS.filter((item) => item.id !== "diff" || grouping === "worktree").map((item) => (
                <Check
                  key={item.id}
                  label={item.label}
                  icon={<item.icon className="size-4 shrink-0 text-icon" />}
                  checked={prefs.show.includes(item.id)}
                  onChange={() => onChange({ ...prefs, show: toggle(prefs.show, item.id) })}
                />
              ))}
            </Submenu>

            <Menu.Separator className="mx-2 my-1 h-px bg-border" />

            <div className="flex h-8 items-center justify-between pr-1 pl-2 text-text-muted">
              <span>Filters</span>
              <Menu.Item
                closeOnClick={false}
                disabled={!filtered}
                onClick={() => {
                  onChange({ ...prefs, recency: DEFAULT_PREFS.recency, limit: DEFAULT_PREFS.limit, hiddenProviders: [] });
                  onHiddenTrees([]);
                }}
                className="cursor-default rounded-md px-1.5 py-0.5 outline-none select-none data-disabled:opacity-40 data-highlighted:bg-hover data-highlighted:text-text"
              >
                Reset
              </Menu.Item>
            </div>

            {worktrees.length > 1 && (
              <Submenu icon={GitBranchIcon} label="Worktree" active={hiddenTrees.length > 0}>
                {worktrees.map((tree) => (
                  <Check
                    key={tree.path}
                    label={worktreeLabel(tree)}
                    icon={tree.branch || !tree.main ? <GitBranchIcon className="size-4 shrink-0 text-icon" /> : <FolderIcon className="size-4 shrink-0 text-icon" />}
                    checked={!hiddenTrees.includes(tree.path)}
                    onChange={() => onHiddenTrees(toggle(hiddenTrees, tree.path))}
                  />
                ))}
              </Submenu>
            )}

            <Submenu icon={ClockIcon} label="Updated" value={recency?.short}>
              <Menu.RadioGroup value={prefs.recency} onValueChange={(value) => onChange({ ...prefs, recency: value as Recency })}>
                {RECENCIES.map((item) => (
                  <Radio key={item.id} value={item.id} label={item.label} />
                ))}
              </Menu.RadioGroup>
            </Submenu>

            <Submenu icon={ListOrderedIcon} label={grouping === "none" ? "Show at most" : "Per group"} value={limitLabel(prefs.limit)}>
              <Menu.RadioGroup value={prefs.limit} onValueChange={(value) => onChange({ ...prefs, limit: value as Limit })}>
                {LIMITS.map((limit) => (
                  <Radio key={limit} value={limit} label={limitLabel(limit)} />
                ))}
              </Menu.RadioGroup>
            </Submenu>

            <Submenu icon={BotIcon} label="Provider" active={prefs.hiddenProviders.length > 0}>
              {PROVIDERS.map((provider) => (
                <Check
                  key={provider.id}
                  label={provider.label}
                  icon={<ProviderIcon provider={provider.id} className="size-4 shrink-0" />}
                  checked={!prefs.hiddenProviders.includes(provider.id)}
                  onChange={() => onChange({ ...prefs, hiddenProviders: toggle(prefs.hiddenProviders, provider.id) })}
                />
              ))}
            </Submenu>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Submenu({ icon: Glyph, label, value, active = false, children }: { icon: Icon; label: string; value?: string | undefined; active?: boolean; children: ReactNode }) {
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
        <Menu.Positioner className="z-50" sideOffset={submenuOffset} alignOffset={submenuOffset}>
          <Menu.Popup className={PANEL}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

function Radio({ value, label }: { value: string | number; label: string }) {
  return (
    <Menu.RadioItem value={value} className={ROW}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Menu.RadioItemIndicator>
        <CheckIcon className="size-4 shrink-0" />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}

function Check({ label, icon, checked, onChange }: { label: string; icon?: ReactNode; checked: boolean; onChange: () => void }) {
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
