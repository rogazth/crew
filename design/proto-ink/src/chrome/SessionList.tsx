import { useEffect, useMemo, useRef, useState } from "react";
import { PROVIDERS, commandKeys, graph, statusLabel } from "@crew/fixtures";
import type { SessionKind } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useLetterIndex } from "@/lib/chat";
import { Icon, type IconName } from "@/lib/icon";
import { useApp } from "@/lib/store";
import {
  GROUPINGS,
  ORDERINGS,
  canReorder,
  filterSessions,
  groupSessions,
  type Grouping,
  type Ordering,
} from "@/lib/sidebar";
import {
  IconButton,
  Menu,
  MenuCheckItem,
  MenuLabel,
  MenuRadioItem,
  MenuSeparator,
  MenuPrimitive,
  ScrollArea,
  Tooltip,
} from "@/ui";
import { SidebarRow } from "./SidebarRow";

/**
 * Rows painted at once, across every group. A four-hundred-session workspace was
 * ~4 000 DOM nodes and 280 MB of heap with the list rendered whole; the reader
 * can see about twenty of them. Same "pull more by scrolling" idiom the
 * transcript uses, rather than a virtualiser — the rows are not a fixed height,
 * because the Show preferences change what a row contains.
 */
const PAGE = 80;
/** How close to the bottom the reader gets before the next page is painted. */
const GROW_PX = 420;

export function SessionList() {
  const { sessions, activeWorkspaceId, prefs, manualOrder, query, actions, activeTab, selection } =
    useApp();
  const dragged = useRef<string | null>(null);

  const visible = useMemo(
    () => filterSessions(sessions, activeWorkspaceId, prefs, query),
    [sessions, activeWorkspaceId, prefs, query],
  );
  const groups = useMemo(
    () => groupSessions(visible, prefs, manualOrder),
    [visible, prefs, manualOrder],
  );
  const reorderable = canReorder(prefs, query);
  const index = useLetterIndex(sessions);
  // One graph pass gives every row its mailbox depth; asking per row would walk
  // every transcript in the workspace once per session.
  const waiting = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph(index.roster).nodes) {
      if (node.waiting > 0) counts.set(node.agent.id, node.waiting);
    }
    return counts;
  }, [index]);
  const activeSessionId = activeTab?.kind === "session" ? activeTab.sessionId : null;

  const onDropOn = (targetId: string) => {
    const moving = dragged.current;
    dragged.current = null;
    if (!moving || moving === targetId) return;
    const order = manualOrder.filter((id) => id !== moving);
    const at = order.indexOf(targetId);
    order.splice(at === -1 ? order.length : at, 0, moving);
    actions.setManualOrder(order);
  };

  const [limit, setLimit] = useState(PAGE);
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);

  // A new query or a new grouping is a new list; keeping the old window would
  // show a "keep scrolling" line under three results.
  useEffect(() => setLimit(PAGE), [query, prefs.grouping, prefs.ordering, activeWorkspaceId]);

  let painted = 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SearchField />
      <div className="flex shrink-0 flex-col px-2 pb-1">
        <ActionRow icon="plus" label="New agent" chord={commandKeys("new-agent")} onClick={() => actions.openSheet(null)} />
        <ActionRow
          icon="terminal"
          label="New session"
          chord={commandKeys("new-session")}
          onClick={() =>
            actions.createSession({ name: `shell ${Math.floor(Math.random() * 90 + 10)}`, kind: "terminal", model: "" })
          }
        />
        <ActionRow icon="routine" label="Routines" chord={commandKeys("open-routines")} onClick={() => actions.openRoutines(null)} />
      </div>

      <ScrollArea
        className="flex-1 px-2 pb-2"
        onScroll={(event) => {
          if (limit >= total) return;
          const box = event.currentTarget;
          if (box.scrollHeight - box.scrollTop - box.clientHeight > GROW_PX) return;
          setLimit((held) => held + PAGE);
        }}
      >
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-small text-quaternary">
            {query ? `Nothing matches “${query}”.` : "No sessions in this workspace yet."}
          </p>
        )}
        {groups.map((group) => {
          const collapsed = prefs.collapsedGroups.includes(group.id);
          // The budget is spent across groups in order, so the cap is a number of
          // rows on screen rather than a number per section.
          const room = Math.max(0, limit - painted);
          const shown = collapsed ? [] : group.sessions.slice(0, room);
          const hidden = collapsed ? 0 : group.sessions.length - shown.length;
          painted += shown.length;
          return (
            <section key={group.id} className="mb-1">
              {prefs.grouping !== "none" && (
                <div className="group/head flex h-6 items-center gap-1 pl-1 pr-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      actions.setPrefs({
                        collapsedGroups: collapsed
                          ? prefs.collapsedGroups.filter((id) => id !== group.id)
                          : [...prefs.collapsedGroups, group.id],
                      })
                    }
                    className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-micro font-[var(--weight-medium)] uppercase tracking-[0.06em] text-quaternary transition-colors hover:text-tertiary"
                  >
                    <Icon
                      name="chevronRight"
                      size={12}
                      className={cx(
                        "transition-transform duration-[var(--dur-2)]",
                        !collapsed && "rotate-90",
                      )}
                    />
                    <span className="truncate">{group.label}</span>
                    <span className="tnum opacity-70">{group.sessions.length}</span>
                  </button>
                  <Tooltip content={group.id === "terminal" ? "New session" : "New agent"}>
                    <IconButton
                      icon="plus"
                      size="sm"
                      label={group.id === "terminal" ? "New session" : "New agent"}
                      className="opacity-0 transition-opacity group-hover/head:opacity-100 focus-visible:opacity-100"
                      onClick={() =>
                        group.id === "terminal"
                          ? actions.createSession({
                              name: `shell ${Math.floor(Math.random() * 90 + 10)}`,
                              kind: "terminal",
                              model: "",
                            })
                          : actions.openSheet(null)
                      }
                    />
                  </Tooltip>
                </div>
              )}
              {shown.map((session) => (
                  <SidebarRow
                    key={session.id}
                    session={session}
                    prefs={prefs}
                    active={session.id === activeSessionId}
                    selected={selection.includes(session.id)}
                    waiting={waiting.get(session.id) ?? 0}
                    draggable={reorderable}
                    onDragStart={() => (dragged.current = session.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => onDropOn(session.id)}
                  />
              ))}
              {hidden > 0 && (
                <p className="px-2 py-1.5 text-small text-quaternary tnum">
                  {hidden.toLocaleString()} more — keep scrolling
                </p>
              )}
            </section>
          );
        })}
      </ScrollArea>

      <div className="shrink-0 border-t border-[var(--stroke-tertiary)] px-2 py-1.5">
        <ActionRow
          icon="settings"
          label="Settings"
          chord={commandKeys("open-settings")}
          onClick={() => actions.openSettings("general")}
        />
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  chord,
  onClick,
}: {
  icon: IconName;
  label: string;
  chord: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group flex h-7 items-center gap-2 rounded-row px-1.5 text-left",
        "text-body text-secondary transition-colors duration-[var(--dur-2)]",
        "hover:bg-[var(--fill-tertiary)] hover:text-primary",
      )}
    >
      <Icon name={icon} size={14} className="shrink-0 text-icon-faint group-hover:text-icon" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-micro text-quaternary opacity-0 transition-opacity group-hover:opacity-100">
        {chord}
      </span>
    </button>
  );
}

/** The preferences menu lives inside the search field, where the app already put it. */
function SearchField() {
  const { query, prefs, actions } = useApp();
  const [open, setOpen] = useState(false);

  const setGrouping = (grouping: Grouping) => actions.setPrefs({ grouping });
  const setOrdering = (ordering: Ordering) => actions.setPrefs({ ordering });
  const toggleKind = (kind: SessionKind) =>
    actions.setPrefs({
      hiddenKinds: prefs.hiddenKinds.includes(kind)
        ? prefs.hiddenKinds.filter((k) => k !== kind)
        : [...prefs.hiddenKinds, kind],
    });
  const toggleProvider = (id: string) =>
    actions.setPrefs({
      hiddenProviders: prefs.hiddenProviders.includes(id)
        ? prefs.hiddenProviders.filter((p) => p !== id)
        : [...prefs.hiddenProviders, id],
    });

  return (
    <div className="shrink-0 px-2 pb-2">
      <div
        className={cx(
          "flex h-7 items-center gap-1.5 rounded-md bg-canvas pl-2 pr-0.5",
          "e1 transition-shadow duration-[var(--dur-2)]",
          "focus-within:shadow-[var(--elev-1),inset_0_0_0_1px_var(--stroke-primary)]",
        )}
      >
        <Icon name="search" size={14} className="shrink-0 text-icon-faint" />
        <input
          value={query}
          onChange={(event) => actions.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") actions.setQuery("");
          }}
          placeholder="Filter sessions"
          className="min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-quaternary"
        />
        {query && (
          <IconButton icon="close" size="sm" label="Clear filter" onClick={() => actions.setQuery("")} />
        )}
        <Menu
          open={open}
          onOpenChange={setOpen}
          align="end"
          width={228}
          trigger={
            <button
              type="button"
              aria-label="List preferences"
              className={cx(
                "flex size-6 shrink-0 items-center justify-center rounded-md text-icon-faint",
                "transition-colors hover:bg-[var(--fill-tertiary)] hover:text-icon",
                "data-[popup-open]:bg-[var(--fill-tertiary)] data-[popup-open]:text-icon",
              )}
            >
              <Icon name="sliders" size={14} />
            </button>
          }
        >
          <MenuLabel>Group by</MenuLabel>
          <MenuPrimitive.RadioGroup
            value={prefs.grouping}
            onValueChange={(next: unknown) => setGrouping(String(next) as Grouping)}
          >
            {GROUPINGS.map((option) => (
              <MenuRadioItem key={option.id} value={option.id}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuPrimitive.RadioGroup>
          <MenuSeparator />
          <MenuLabel>Order by</MenuLabel>
          <MenuPrimitive.RadioGroup
            value={prefs.ordering}
            onValueChange={(next: unknown) => setOrdering(String(next) as Ordering)}
          >
            {ORDERINGS.map((option) => (
              <MenuRadioItem key={option.id} value={option.id}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuPrimitive.RadioGroup>
          {!canReorder(prefs, query) && prefs.ordering === "manual" && (
            <p className="px-2 pb-1 pt-0.5 text-micro leading-[14px] text-quaternary">
              Drag to reorder needs grouping by kind and no filter.
            </p>
          )}
          <MenuSeparator />
          <MenuLabel>Show</MenuLabel>
          <MenuCheckItem
            checked={prefs.showProvider}
            onCheckedChange={(next: boolean) => actions.setPrefs({ showProvider: next })}
          >
            Provider and model
          </MenuCheckItem>
          <MenuCheckItem
            checked={prefs.showUpdated}
            onCheckedChange={(next: boolean) => actions.setPrefs({ showUpdated: next })}
          >
            Last updated
          </MenuCheckItem>
          <MenuCheckItem
            checked={prefs.showStatus}
            onCheckedChange={(next: boolean) => actions.setPrefs({ showStatus: next })}
          >
            Status
          </MenuCheckItem>
          <MenuCheckItem
            checked={prefs.showAvatar}
            onCheckedChange={(next: boolean) => actions.setPrefs({ showAvatar: next })}
          >
            Avatar
          </MenuCheckItem>
          <MenuSeparator />
          <MenuLabel>Hide</MenuLabel>
          <MenuCheckItem
            checked={prefs.hiddenKinds.includes("terminal")}
            onCheckedChange={() => toggleKind("terminal")}
          >
            Terminals
          </MenuCheckItem>
          <MenuCheckItem
            checked={prefs.hiddenKinds.includes("agent")}
            onCheckedChange={() => toggleKind("agent")}
          >
            Agents
          </MenuCheckItem>
          {PROVIDERS.map((provider) => (
            <MenuCheckItem
              key={provider.id}
              checked={prefs.hiddenProviders.includes(provider.id)}
              onCheckedChange={() => toggleProvider(provider.id)}
            >
              {provider.label} agents
            </MenuCheckItem>
          ))}
          {prefs.grouping === "status" && (
            <>
              <MenuSeparator />
              <p className="px-2 pb-1 pt-0.5 text-micro leading-[14px] text-quaternary">
                Ordered {statusLabel("needs-input").toLowerCase()} first.
              </p>
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}
