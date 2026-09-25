// PROTOTYPE — pieces the variants share: faces, tiles, rows, filter menu, sidebar keyboard nav.
import { Menu } from "@base-ui/react/menu";
import type { Style, StyleDefinition } from "@dicebear/core";
import {
  ArrowsDownUpIcon,
  CaretRightIcon,
  CheckIcon,
  CircleNotchIcon,
  ClockIcon,
  EyeIcon,
  FunnelSimpleIcon,
  GitBranchIcon,
  GitDiffIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  ShapesIcon,
  SidebarSimpleIcon,
  StackIcon,
  TerminalWindowIcon,
  TextAaIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { avatarUri, loadAvatarStyle, type AgentAvatarId } from "../../lib/agentAvatar";
import type { SessionStatus } from "../../lib/types";
import { StatusDot } from "../../chrome/StatusDot";
import type { Cmd } from "./keys";
import { keysOf } from "./keys";
import { currentWorktree, sessionsOf, worktreesOf, type Session, type State, type Worktree } from "./store";
import { fuzzyMatch } from "../../lib/fuzzy";

// ── Shared contract ────────────────────────────────────────────────────

export type Prefs = {
  scope: "all" | "current" | "busy";
  hideKinds: Session["kind"][];
  ordering: "manual" | "updated" | "name";
  names: boolean;
  diff: boolean;
};

export const DEFAULT_PREFS: Prefs = { scope: "all", hideKinds: [], ordering: "manual", names: true, diff: true };

export type SidebarProps = {
  st: State;
  update: (fn: (st: State) => State) => void;
  run: (cmd: Cmd) => void;
  prefs: Prefs;
  setPrefs: (prefs: Prefs) => void;
  query: string;
  setQuery: (query: string) => void;
  searching: boolean;
  setSearching: (open: boolean) => void;
  openSession: (id: string) => void;
  askRename: (id: string) => void;
  askRemove: (kind: string, id: string) => void;
};

/** What the query and prefs leave of a worktree's sessions. */
export function visibleSessions(p: SidebarProps, tree: Worktree): Session[] {
  const q = p.query.trim();
  const list = p.st.sessions.filter(
    (x) =>
      x.worktreeId === tree.id &&
      !p.prefs.hideKinds.includes(x.kind) &&
      (!q || fuzzyMatch(q, x.name) || fuzzyMatch(q, tree.branch)),
  );
  if (p.prefs.ordering === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

/** Worktrees the scope and query leave in the sidebar. The current one always stays. */
export function visibleWorktrees(p: SidebarProps): Worktree[] {
  const current = currentWorktree(p.st).id;
  const q = p.query.trim();
  return worktreesOf(p.st, p.st.activeWorkspace).filter((tree) => {
    if (p.prefs.scope === "current" && tree.id !== current) return false;
    if (p.prefs.scope === "busy" && tree.id !== current && !sessionsOf(p.st, tree.id).some((x) => x.status !== "idle"))
      return false;
    return !q || visibleSessions(p, tree).length > 0;
  });
}

// ── Faces ──────────────────────────────────────────────────────────────

export const AvatarStyle = createContext<AgentAvatarId>("gaze");

function useFaceStyle(id: AgentAvatarId) {
  const [loaded, setLoaded] = useState<{ id: AgentAvatarId; style: Style<StyleDefinition> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadAvatarStyle(id).then((style) => !cancelled && setLoaded({ id, style }));
    return () => {
      cancelled = true;
    };
  }, [id]);
  return loaded?.id === id ? loaded.style : null;
}

/** The face alone, unclipped: the shape is the identity, not a circle around it. */
export function Face({ seed, className = "size-10" }: { seed: string; className?: string }) {
  const id = useContext(AvatarStyle);
  const style = useFaceStyle(id);
  if (!style) return <span className={`${className} shrink-0 rounded-full bg-card`} />;
  return <img src={avatarUri(id, style, seed)} alt="" aria-hidden draggable={false} className={`${className} shrink-0`} />;
}

const BADGE: Partial<Record<SessionStatus, string>> = {
  "needs-input": "bg-kumo-warning",
  done: "bg-kumo-info",
  error: "bg-kumo-danger",
};

/** Status rides the face's corner, like the unread dot on an app icon. */
export function FaceBadge({ status, ring = "ring-sidebar" }: { status: SessionStatus; ring?: string }) {
  if (status === "idle") return null;
  if (status === "working")
    return (
      <span className={`absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-sidebar ring-2 ${ring}`}>
        <CircleNotchIcon className="size-3 animate-spin text-kumo-warning" />
      </span>
    );
  return <span className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ${ring} ${BADGE[status]}`} />;
}

// ── Rows and tiles ─────────────────────────────────────────────────────

const FOCUS = "outline-none focus-visible:ring-1 focus-visible:ring-border-strong";

export function AgentTile({
  session,
  active,
  names,
  size = "md",
  hint,
  onOpen,
}: {
  session: Session;
  active: boolean;
  names: boolean;
  size?: "sm" | "md" | "lg";
  hint?: string;
  onOpen: () => void;
}) {
  const face = size === "lg" ? "size-14" : size === "md" ? "size-10" : "size-8";
  return (
    <button
      type="button"
      data-nav
      data-id={session.id}
      data-kind="agent"
      aria-current={active ? "page" : undefined}
      title={hint ?? session.name}
      onClick={onOpen}
      className={`flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 transition-colors ${
        size === "lg" ? "pt-3 pb-2" : "pt-2 pb-1.5"
      } ${active ? "bg-selected" : "hover:bg-hover focus-visible:bg-hover"} ${FOCUS}`}
    >
      <span className="relative">
        <Face seed={session.id} className={face} />
        <FaceBadge status={session.status} ring={active ? "ring-selected" : "ring-sidebar"} />
      </span>
      {names && (
        <span className={`w-full truncate text-center ${size === "sm" ? "text-[11px]" : "text-[12px]"} ${active ? "font-medium" : ""}`}>
          {session.name}
        </span>
      )}
    </button>
  );
}

export function AddTile({ label, size = "md", onClick }: { label: string; size?: "sm" | "md" | "lg"; onClick: () => void }) {
  const face = size === "lg" ? "size-14" : size === "md" ? "size-10" : "size-8";
  return (
    <button
      type="button"
      data-nav
      title={`${label} ${keysOf("new-agent")}`}
      onClick={onClick}
      className={`flex flex-col items-center gap-1 rounded-xl px-1 text-kumo-subtle transition-colors hover:bg-hover hover:text-kumo-default focus-visible:bg-hover ${
        size === "lg" ? "pt-3 pb-2" : "pt-2 pb-1.5"
      } ${FOCUS}`}
    >
      <span className={`${face} grid place-items-center rounded-full border border-dashed border-border-strong text-lg`}>+</span>
      <span className="text-[12px]">{label}</span>
    </button>
  );
}

export function SessionRow({ session, active, onOpen }: { session: Session; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-nav
      data-id={session.id}
      data-kind="terminal"
      aria-current={active ? "page" : undefined}
      onClick={onOpen}
      className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left transition-colors ${
        active ? "bg-selected" : "hover:bg-hover focus-visible:bg-hover"
      } ${FOCUS}`}
    >
      <TerminalWindowIcon className={`size-4 shrink-0 ${active ? "" : "text-kumo-subtle"}`} />
      <span className="min-w-0 flex-1 truncate">{session.name}</span>
      <StatusDot status={session.status} />
    </button>
  );
}

export function ActionRow({ icon: Glyph, label, keys, onClick }: { icon: Icon; label: string; keys?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-nav
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left transition-colors hover:bg-hover focus-visible:bg-hover ${FOCUS}`}
    >
      <Glyph className="size-4 shrink-0 text-kumo-subtle" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {keys && <span className="shrink-0 text-[11px] text-kumo-subtle">{keys}</span>}
    </button>
  );
}

export function DiffStat({ tree }: { tree: Worktree }) {
  if (!tree.add && !tree.del) return null;
  return (
    <span className="shrink-0 text-[11px] tabular-nums">
      <span className="text-[oklch(62%_0.15_150)]">+{tree.add}</span>{" "}
      <span className="text-[oklch(62%_0.17_25)]">−{tree.del}</span>
    </span>
  );
}

export function BranchDot({ hue, className = "size-2" }: { hue: number; className?: string }) {
  return <span className={`${className} shrink-0 rounded-full`} style={{ background: `oklch(68% 0.14 ${hue})` }} />;
}

/** Group header for a worktree: branch, diff, loudest status; ←/→ fold it from the keyboard. */
export function WorktreeHeader({
  tree,
  status,
  active,
  open,
  showDiff,
  hint,
  onToggle,
  onSelect,
  onAdd,
}: {
  tree: Worktree;
  status: SessionStatus;
  active: boolean;
  open: boolean;
  showDiff: boolean;
  hint?: string;
  onToggle: () => void;
  onSelect: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="group/wt flex h-8 items-center gap-0.5">
      <button
        type="button"
        data-nav
        data-id={tree.id}
        data-kind="worktree"
        data-collapse={tree.id}
        data-open={open}
        aria-current={active ? "true" : undefined}
        aria-expanded={open}
        title={`${tree.path}${hint ? `  ${hint}` : ""}`}
        onClick={onSelect}
        className={`flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-chrome pr-1.5 pl-1 text-left transition-colors hover:bg-hover focus-visible:bg-hover ${FOCUS} ${
          active ? "text-kumo-default" : "text-kumo-subtle"
        }`}
      >
        <span
          role="presentation"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className="grid size-4 shrink-0 place-items-center rounded hover:bg-selected"
        >
          <CaretRightIcon className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
        </span>
        <GitBranchIcon className="size-3.5 shrink-0" />
        <span className={`min-w-0 flex-1 truncate ${active ? "font-semibold" : "font-medium"}`}>{tree.branch}</span>
        {showDiff && <DiffStat tree={tree} />}
        {!open && <StatusDot status={status} />}
      </button>
      <button
        type="button"
        title={`New agent in ${tree.branch}`}
        onClick={onAdd}
        className="grid size-6 shrink-0 place-items-center rounded-md text-kumo-subtle opacity-0 transition-opacity group-hover/wt:opacity-100 hover:bg-hover hover:text-kumo-default"
      >
        +
      </button>
    </div>
  );
}

// ── Window chrome ──────────────────────────────────────────────────────

/** The browser has no traffic lights; these stand where macOS draws them. */
export function TrafficLights() {
  return (
    <div className="flex w-[70px] shrink-0 items-center gap-2 pl-[13px]" aria-hidden>
      <span className="size-3 rounded-full bg-[#ff5f57]" />
      <span className="size-3 rounded-full bg-[#febc2e]" />
      <span className="size-3 rounded-full bg-[#28c840]" />
    </div>
  );
}

export function SidebarToggle({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      title={`Toggle sidebar ${keysOf("toggle-sidebar")}`}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-kumo-subtle transition-colors hover:bg-hover hover:text-kumo-default"
    >
      <SidebarSimpleIcon className="size-[18px]" weight="regular" />
    </button>
  );
}

export function IconButton({ icon: Glyph, label, active, onClick }: { icon: Icon; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-hover hover:text-kumo-default ${
        active ? "text-kumo-default" : "text-kumo-subtle"
      }`}
    >
      <Glyph className="size-4" />
    </button>
  );
}

export function Mark({ name, className = "size-6 rounded-md text-[11px]" }: { name: string; className?: string }) {
  const initials = name.split(/[\s\-_.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center bg-kumo-brand font-semibold tracking-wide text-kumo-inverse ${className}`}>
      {initials}
    </span>
  );
}

// ── Section header: label, search, filter — one line, one family ──────

export function SectionHeader({ label, p, extra }: { label: string; p: SidebarProps; extra?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (p.searching) input.current?.focus();
  }, [p.searching]);

  if (p.searching) {
    return (
      <div className="flex h-8 items-center gap-2 rounded-chrome bg-card px-2">
        <MagnifyingGlassIcon className="size-3.5 shrink-0 text-kumo-subtle" />
        <input
          ref={input}
          value={p.query}
          placeholder={`Filter ${label.toLowerCase()}`}
          spellCheck={false}
          onChange={(event) => p.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              p.setQuery("");
              p.setSearching(false);
              focusSidebar();
            }
            if (event.key === "ArrowDown" || event.key === "Enter") {
              event.preventDefault();
              const first = document.querySelector<HTMLElement>("[data-sidebar-root] [data-nav][data-kind]");
              if (event.key === "Enter") first?.click();
              else first?.focus();
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent outline-none"
        />
        <IconButton
          icon={XIcon}
          label="Clear"
          onClick={() => {
            p.setQuery("");
            p.setSearching(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-8 items-center gap-0.5 pl-2">
      <span className="min-w-0 flex-1 truncate text-kumo-subtle">{label}</span>
      {extra}
      <IconButton icon={MagnifyingGlassIcon} label="Filter  /" onClick={() => p.setSearching(true)} />
      <FilterMenu prefs={p.prefs} onChange={p.setPrefs} />
    </div>
  );
}

// ── Filter popover: same shape as today's, now with icons on every row ──

const PANEL =
  "max-h-[70vh] w-56 origin-(--transform-origin) overflow-y-auto rounded-xl bg-kumo-control p-1 text-kumo-default shadow-lg ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";
const ROW =
  "flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-left outline-none select-none data-highlighted:bg-hover data-popup-open:bg-hover";

const SCOPES: { id: Prefs["scope"]; label: string; icon: Icon }[] = [
  { id: "all", label: "All worktrees", icon: StackIcon },
  { id: "current", label: "Current only", icon: GitBranchIcon },
  { id: "busy", label: "With activity", icon: CircleNotchIcon },
];
const ORDERS: { id: Prefs["ordering"]; label: string; icon: Icon }[] = [
  { id: "manual", label: "Manual", icon: ShapesIcon },
  { id: "updated", label: "Updated", icon: ClockIcon },
  { id: "name", label: "Name", icon: TextAaIcon },
];

export function FilterMenu({ prefs, onChange }: { prefs: Prefs; onChange: (prefs: Prefs) => void }) {
  const dirty = JSON.stringify(prefs) !== JSON.stringify(DEFAULT_PREFS);
  const toggleKind = (kind: Session["kind"]) =>
    onChange({
      ...prefs,
      hideKinds: prefs.hideKinds.includes(kind) ? prefs.hideKinds.filter((k) => k !== kind) : [...prefs.hideKinds, kind],
    });
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label="Customize sidebar"
        title="Customize sidebar"
        className={`relative grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-hover hover:text-kumo-default data-popup-open:bg-hover ${
          dirty ? "text-kumo-default" : "text-kumo-subtle"
        }`}
      >
        <FunnelSimpleIcon className="size-4" />
        {dirty && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-kumo-default ring-2 ring-sidebar" />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="right" align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            <Submenu icon={StackIcon} label="Worktrees" value={SCOPES.find((x) => x.id === prefs.scope)?.label}>
              <Menu.RadioGroup value={prefs.scope} onValueChange={(v) => onChange({ ...prefs, scope: v as Prefs["scope"] })}>
                {SCOPES.map((item) => (
                  <Radio key={item.id} value={item.id} icon={item.icon} label={item.label} />
                ))}
              </Menu.RadioGroup>
            </Submenu>
            <Submenu icon={ArrowsDownUpIcon} label="Ordering" value={ORDERS.find((x) => x.id === prefs.ordering)?.label}>
              <Menu.RadioGroup value={prefs.ordering} onValueChange={(v) => onChange({ ...prefs, ordering: v as Prefs["ordering"] })}>
                {ORDERS.map((item) => (
                  <Radio key={item.id} value={item.id} icon={item.icon} label={item.label} />
                ))}
              </Menu.RadioGroup>
            </Submenu>
            <Submenu icon={EyeIcon} label="Show">
              <Check icon={TextAaIcon} label="Agent names" checked={prefs.names} onChange={() => onChange({ ...prefs, names: !prefs.names })} />
              <Check icon={GitDiffIcon} label="Diff stats" checked={prefs.diff} onChange={() => onChange({ ...prefs, diff: !prefs.diff })} />
            </Submenu>
            <Menu.Separator className="mx-2 my-1 h-px bg-kumo-line" />
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
            <Submenu icon={ShapesIcon} label="Kind" active={prefs.hideKinds.length > 0}>
              <Check icon={RobotIcon} label="Agents" checked={!prefs.hideKinds.includes("agent")} onChange={() => toggleKind("agent")} />
              <Check icon={TerminalWindowIcon} label="Sessions" checked={!prefs.hideKinds.includes("terminal")} onChange={() => toggleKind("terminal")} />
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
        <Glyph className="size-4 shrink-0 text-kumo-subtle" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {value && <span className="shrink-0 text-kumo-subtle">{value}</span>}
        {active && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current text-kumo-subtle" />}
        <CaretRightIcon className="size-3.5 shrink-0 text-kumo-subtle" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner className="z-50" sideOffset={-4} alignOffset={-4}>
          <Menu.Popup className={PANEL}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

function Radio({ value, icon: Glyph, label }: { value: string; icon: Icon; label: string }) {
  return (
    <Menu.RadioItem value={value} className={ROW}>
      <Glyph className="size-4 shrink-0 text-kumo-subtle" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Menu.RadioItemIndicator>
        <CheckIcon className="size-4 shrink-0" />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}

function Check({ icon: Glyph, label, checked, onChange }: { icon: Icon; label: string; checked: boolean; onChange: () => void }) {
  return (
    <Menu.CheckboxItem checked={checked} onCheckedChange={onChange} className={ROW}>
      <Glyph className="size-4 shrink-0 text-kumo-subtle" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Menu.CheckboxItemIndicator>
        <CheckIcon className="size-4 shrink-0" />
      </Menu.CheckboxItemIndicator>
    </Menu.CheckboxItem>
  );
}

// ── Sidebar keyboard: spatial arrows, so a grid and a list share one set of keys ──

export function focusSidebar() {
  const root = document.querySelector("[data-sidebar-root]");
  const target =
    root?.querySelector<HTMLElement>("[data-nav][aria-current='page']") ??
    root?.querySelector<HTMLElement>("[data-nav][aria-current]") ??
    root?.querySelector<HTMLElement>("[data-nav]");
  target?.focus();
}

type Dir = "up" | "down" | "left" | "right";

function spatial(root: HTMLElement, from: HTMLElement, dir: Dir): HTMLElement | null {
  const items = [...root.querySelectorAll<HTMLElement>("[data-nav]")].filter((el) => el !== from && el.offsetParent);
  const r = from.getBoundingClientRect();
  const rx = r.left + Math.min(r.width / 2, 16);
  const cy = r.top + r.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    const e = el.getBoundingClientRect();
    const ey = e.top + e.height / 2;
    let score: number;
    if (dir === "up" || dir === "down") {
      const dy = ey - cy;
      if (dir === "down" ? dy <= 2 : dy >= -2) continue;
      const dx = Math.max(0, e.left - rx, rx - e.right);
      score = Math.abs(dy) + dx * 3;
    } else {
      const overlap = Math.min(r.bottom, e.bottom) - Math.max(r.top, e.top);
      if (overlap < Math.min(r.height, e.height) / 2) continue;
      const dx = e.left + e.width / 2 - (r.left + r.width / 2);
      if (dir === "right" ? dx <= 2 : dx >= -2) continue;
      score = Math.abs(dx);
    }
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export function useSidebarKeys(
  root: RefObject<HTMLElement | null>,
  on: {
    toggle: (worktreeId: string, open: boolean) => void;
    rename: (id: string) => void;
    remove: (kind: string, id: string) => void;
    search: () => void;
  },
) {
  const latest = useRef(on);
  useEffect(() => {
    latest.current = on;
  });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT") return;
      const nav = target.closest<HTMLElement>("[data-nav]");
      const dirs: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
      const dir = dirs[event.key];
      if (dir && nav && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        const fold = nav.dataset.collapse;
        if (fold && (dir === "left" || dir === "right")) {
          latest.current.toggle(fold, dir === "right");
          return;
        }
        const next = spatial(el, nav, dir);
        next?.focus();
        next?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "/" && !event.metaKey) {
        event.preventDefault();
        latest.current.search();
        return;
      }
      if (event.key === "Escape") {
        document.querySelector<HTMLElement>("[data-main]")?.focus();
        return;
      }
      const id = nav?.dataset.id;
      const kind = nav?.dataset.kind;
      if (!id || !kind) return;
      if (event.key === "F2" && kind !== "worktree") {
        event.preventDefault();
        latest.current.rename(id);
      }
      if ((event.key === "Backspace" || event.key === "Delete") && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        latest.current.remove(kind, id);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [root]);
}

/** Jump hint for the nth worktree, the way the workspace picker teaches ⌘1‥9. */
export const worktreeKeys = (index: number) => (index < 9 ? keysOf(`worktree-${index + 1}`) : "");
export const workspaceKeys = (index: number) => (index < 9 ? keysOf(`workspace-${index + 1}`) : "");
