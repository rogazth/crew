import { useRef, useState } from "react";
import {
  STATUS_ORDER,
  hugeTable,
  pathologicalMarkdown,
  stressSessions,
  type SessionStatus,
} from "@crew/fixtures";
import { Menu, type MenuItem } from "@/ui";
import { resolveTheme, store, useApp } from "@/lib/store";
import { demoRuntime } from "@/lib/source";

const LETTERS: Array<{ id: string; name: string; text: string }> = [
  {
    id: "s-renderer",
    name: "renderer",
    text: "El tab strip ya lee el estado del runtime. ¿Le pongo el número del atajo en la píldora o lo dejo sólo en el status line?",
  },
  {
    id: "s-scribe",
    name: "scribe",
    text: "Documenté el contrato del log de dos columnas. Falta decidir si el gutter es ancho fijo o se mide contra el nombre más largo.",
  },
  {
    id: "s-daemon",
    name: "daemon",
    text: "El índice FTS ya devuelve `pos` estable entre resyncs, así que un hit de búsqueda puede abrir el bloque exacto.",
  },
];

/** A dev affordance, clearly marked. It is the difference between a mockup and a demo. */
export function DemoMenu() {
  const state = useApp();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [letter, setLetter] = useState(0);

  const targetId = (() => {
    const tabs = state.tabsByWorkspace[state.workspaceId];
    const tab = tabs?.tabs.find((t) => t.id === tabs.activeId);
    if (tab?.kind === "session") {
      const session = state.sessions.find((s) => s.id === tab.sessionId);
      if (session?.kind === "agent") return session.id;
    }
    return "s-harness";
  })();

  const target = state.sessions.find((s) => s.id === targetId);
  const runtime = () => demoRuntime(target ?? { ...state.sessions[0]!, id: targetId });

  const post = (text: string) => {
    store.openSession(targetId);
    const live = runtime();
    live.apply({ type: "message.delta", text });
    live.apply({ type: "message.completed" });
  };

  const items: MenuItem[] = [
    { kind: "label", id: "l-turn", label: `Turn — ${target?.name ?? targetId}` },
    {
      id: "stream",
      label: "Stream a reply",
      detail: "reasoning, tools, markdown",
      onSelect: () => {
        store.openSession(targetId);
        runtime().send("Dame el estado del seam multi-provider.");
      },
    },
    {
      id: "approval",
      label: "Raise an approval",
      onSelect: () => {
        store.openSession(targetId);
        runtime().sendAndAskApproval("Reescribí index.css con la escala nueva.");
      },
    },
    {
      id: "question",
      label: "Raise a question",
      onSelect: () => {
        store.openSession(targetId);
        runtime().sendAndAsk("¿Qué hacemos con la elevación?");
      },
    },
    {
      id: "letter",
      label: `Receive a letter from ${LETTERS[letter % LETTERS.length]!.name}`,
      onSelect: () => {
        const entry = LETTERS[letter % LETTERS.length]!;
        setLetter((held) => held + 1);
        store.openSession(targetId);
        runtime().receiveFrom({ id: entry.id, name: entry.name }, entry.text);
        store.setStatus(targetId, "needs-input");
      },
    },
    {
      id: "stop",
      label: "Interrupt the turn",
      onSelect: () => runtime().stop(),
    },
    { kind: "separator", id: "s1" },
    { kind: "label", id: "l-state", label: "State" },
    {
      id: "statuses",
      label: "Flip every session status",
      onSelect: () => {
        for (const [index, session] of store.state.sessions.entries()) {
          const at = STATUS_ORDER.indexOf(session.status);
          const next = STATUS_ORDER[(at + index + 1) % STATUS_ORDER.length] as SessionStatus;
          store.setStatus(session.id, next);
        }
      },
    },
    {
      id: "all-working",
      label: "Set every session working",
      onSelect: () => {
        for (const session of store.state.sessions) store.setStatus(session.id, "working");
      },
    },
    {
      id: "all-idle",
      label: "Set every session idle",
      onSelect: () => {
        for (const session of store.state.sessions) store.setStatus(session.id, "idle");
      },
    },
    { kind: "separator", id: "s2" },
    { kind: "label", id: "l-stress", label: "Stress" },
    {
      id: "stress-thread",
      label: "Open a 5,000-block transcript",
      onSelect: () => {
        const id = "stress-thread";
        if (!store.session(id)) {
          store.createSession({ id, kind: "agent", name: "stress", description: "5000" });
        }
        store.openSession(id);
      },
    },
    {
      id: "stress-sessions",
      label: "Add 400 sessions to the sidebar",
      onSelect: () => {
        const extra = stressSessions(400, store.state.workspaceId, 11).filter(
          (session) => !store.session(session.id),
        );
        store.addSessions(extra);
      },
    },
    {
      id: "stress-markdown",
      label: "Post pathological markdown",
      onSelect: () => post(pathologicalMarkdown()),
    },
    {
      id: "stress-table",
      label: "Post a 500-row table",
      onSelect: () => post(`## A table that must scroll inside its own box\n\n${hugeTable(500, 12)}`),
    },
    { kind: "separator", id: "s3" },
    { kind: "label", id: "l-view", label: "View" },
    {
      id: "theme",
      label: `Switch to ${resolveTheme(state.theme) === "dark" ? "light" : "dark"}`,
      detail: "⌘⇧J",
      onSelect: () => store.toggleTheme(),
    },
    {
      id: "density",
      label: `Density: ${state.density}`,
      onSelect: () =>
        store.setDensity(state.density === "comfortable" ? "compact" : "comfortable"),
    },
    {
      id: "shortcuts",
      label: "Shortcut sheet",
      detail: "?",
      onSelect: () => store.openOverlay({ kind: "shortcuts" }),
    },
  ];

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((held) => !held)}
        title="Demo controls — not part of the product"
        className="flex h-4 items-center gap-1 rounded-[var(--r)] border border-dashed border-rule-strong px-1.5 font-mono text-xs text-ink-3 hover:border-accent hover:text-accent-ink"
      >
        demo
      </button>
      <Menu
        open={open}
        anchor={ref.current}
        onClose={() => setOpen(false)}
        items={items}
        align="end"
        label="Demo"
        width={272}
      />
    </>
  );
}
