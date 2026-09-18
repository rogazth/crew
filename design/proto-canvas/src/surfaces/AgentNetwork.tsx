import { useMemo, useState } from "react";
import { dayLabel } from "@crew/fixtures";
import { useGraph, useLineage, useRoster } from "@/lib/agents";
import { cx } from "@/lib/cx";
import { agentTint } from "@/lib/identity";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Badge } from "@/ui/Badge";
import { Empty } from "@/ui/Empty";
import { Icon } from "@/ui/Icon";
import { Section } from "@/ui/Field";

const SIZE = 400;
const RADIUS = 142;

/**
 * A page the app does not have and obviously wants: who has written to whom,
 * what is still queued, and who created whom. The graph is the index; the two
 * lists under it are the content.
 */
export function AgentNetworkPage() {
  const { sessions, dark, setDrawer, openSession, statusOf } = useStore();
  const roster = useRoster(sessions);
  const network = useGraph(roster);
  const tree = useLineage(sessions);
  const [hover, setHover] = useState<string | null>(null);

  const active = useMemo(
    () => network.nodes.filter((node) => node.sent + node.received > 0),
    [network.nodes],
  );

  const nodes = useMemo(
    () =>
      active.map((node, index) => {
        const angle = (index / Math.max(1, active.length)) * Math.PI * 2 - Math.PI / 2;
        return {
          id: node.agent.id,
          name: node.agent.name,
          waiting: node.waiting,
          x: SIZE / 2 + Math.cos(angle) * RADIUS,
          y: SIZE / 2 + Math.sin(angle) * RADIUS,
        };
      }),
    [active],
  );

  const at = (id: string) => nodes.find((node) => node.id === id);
  const maxCount = Math.max(1, ...network.edges.map((edge) => edge.count));

  return (
    <div className="scroller min-h-0 flex-1">
      <div className="mx-auto w-full max-w-[880px] px-8 pb-16 pt-10">
        <h1 className="mb-1 text-xl">Agent network</h1>
        <p className="mb-6 text-base text-ink-52">
          Inbound and outbound are the same conversation. A letter that has not landed yet is still in a box.
        </p>

        {network.conversations.length === 0 ? (
          <Empty icon="network" title="No agent traffic yet" description="Agents that write to each other show up here." />
        ) : (
          <>
            <div className="mb-8 flex justify-center rounded-card bg-raised py-5 el-1">
              <div className="relative" style={{ width: SIZE, height: SIZE }}>
                <svg width={SIZE} height={SIZE} className="absolute inset-0" aria-hidden>
                  <defs>
                    <marker
                      id="canvas-arrow"
                      markerUnits="userSpaceOnUse"
                      markerWidth="9"
                      markerHeight="9"
                      refX="7"
                      refY="4.5"
                      orient="auto"
                    >
                      <path d="M0,1 L8,4.5 L0,8 Z" fill="var(--ink-38)" />
                    </marker>
                  </defs>
                  {network.edges.map((edge) => {
                    const from = at(edge.from.id);
                    const to = at(edge.to.id);
                    if (!from || !to) return null;
                    const lit = hover === null || hover === edge.from.id || hover === edge.to.id;
                    // Pull the line back from the node so the arrow is not buried
                    // under the avatar.
                    const dx = to.x - from.x;
                    const dy = to.y - from.y;
                    const len = Math.hypot(dx, dy) || 1;
                    const pad = 26;
                    return (
                      <line
                        key={`${edge.from.id}->${edge.to.id}`}
                        x1={from.x + (dx / len) * pad}
                        y1={from.y + (dy / len) * pad}
                        x2={to.x - (dx / len) * pad}
                        y2={to.y - (dy / len) * pad}
                        stroke={edge.waiting > 0 ? "var(--status-attention)" : agentTint(edge.from.name, dark)}
                        strokeWidth={1 + (edge.count / maxCount) * 4}
                        strokeLinecap="round"
                        strokeDasharray={edge.waiting > 0 ? "5 4" : undefined}
                        markerEnd="url(#canvas-arrow)"
                        opacity={lit ? 0.55 : 0.1}
                        style={{ transition: "opacity 120ms var(--ease-out)" }}
                      />
                    );
                  })}
                </svg>
                {nodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onMouseEnter={() => setHover(node.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => openSession(node.id)}
                    className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
                    style={{ left: node.x, top: node.y }}
                  >
                    <span className="relative rounded-full bg-raised p-0.5 el-2">
                      <Avatar seed={node.name} size={36} status={statusOf(node.id)} />
                      {node.waiting > 0 && (
                        <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-[var(--status-attention)] text-2xs font-bold text-[oklch(0.25_0.05_70)]">
                          {node.waiting}
                        </span>
                      )}
                    </span>
                    <span className="whitespace-nowrap rounded-chip bg-raised px-1.5 text-xs text-ink-52">
                      {node.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <Section title="Conversations" description="Click one to open the thread in the drawer.">
              {network.conversations.map((conversation) => {
                const last = conversation.letters.at(-1);
                return (
                  <button
                    key={`${conversation.a.id}-${conversation.b.id}`}
                    type="button"
                    onMouseEnter={() => setHover(conversation.a.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => setDrawer({ kind: "agent-thread", sessionId: conversation.a.id, peerId: conversation.b.id })}
                    className={cx(
                      "flex w-full items-center gap-3 border-b border-[var(--line-soft)] px-4 py-3 text-left last:border-b-0",
                      "hover:bg-sunken",
                    )}
                  >
                    <span className="flex shrink-0 items-center">
                      <Avatar seed={conversation.a.name} size={26} />
                      <span className="-ml-2 rounded-full ring-2 ring-[var(--raised)]">
                        <Avatar seed={conversation.b.name} size={26} />
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-base font-medium text-ink">
                        <span className="truncate">
                          {conversation.a.name} <span className="text-ink-38">·</span> {conversation.b.name}
                        </span>
                        {conversation.waiting > 0 && <Badge tone="warn">{conversation.waiting} waiting</Badge>}
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-ink-52">{last?.text}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm tabular-nums text-ink-70">
                        {conversation.letters.length} {conversation.letters.length === 1 ? "letter" : "letters"}
                      </span>
                      <span className="block text-xs text-ink-38">{dayLabel(conversation.lastAt)}</span>
                    </span>
                    <Icon name="chevronRight" size={15} className="shrink-0 text-ink-38" />
                  </button>
                );
              })}
            </Section>

            <Section title="Lineage" description="Which agent created which. The store has always known; nothing drew it.">
              {tree.flatMap(function walk(node): React.ReactNode[] {
                return [
                  <button
                    key={node.session.id}
                    type="button"
                    onClick={() => openSession(node.session.id)}
                    className="flex w-full items-center gap-2.5 border-b border-[var(--line-soft)] px-4 py-2.5 text-left last:border-b-0 hover:bg-sunken"
                    style={{ paddingLeft: 16 + node.depth * 22 }}
                  >
                    {node.depth > 0 && <Icon name="chevronRight" size={13} className="shrink-0 text-ink-38" />}
                    <Avatar seed={node.session.name} size={24} status={statusOf(node.session.id)} />
                    <span className="min-w-0 flex-1 truncate text-base text-ink">{node.session.name}</span>
                    {node.session.createdBy && (
                      <span className="shrink-0 text-xs text-ink-38">by {node.session.createdBy.name}</span>
                    )}
                  </button>,
                  ...node.children.flatMap(walk),
                ];
              })}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
