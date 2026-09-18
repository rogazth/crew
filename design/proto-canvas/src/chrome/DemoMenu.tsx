import { STATUS_ORDER, sessionRuntime, type SessionStatus } from "@crew/fixtures";
import { useStore } from "@/lib/store";
import { Icon } from "@/ui/Icon";
import { MenuItem, MenuLabel, MenuRoot, MenuSep } from "@/ui/Menu";

const LETTERS: Array<[string, string, string]> = [
  ["s-relay", "Relay", "¿Podés tomar el transcript cuando termines con el seam? renderer se queda con el shell."],
  ["s-renderer", "renderer", "El drawer ya acepta tres contenidos. Si querés meter el diff ahí, es una línea."],
  ["s-scribe", "scribe", "Documenté el contrato de bloques. Faltan los campos que agregaste hoy."],
];

/**
 * A dev affordance, marked as one. Everything here drives the same fake daemon
 * the composer drives, so what the user sees is what a real turn would look like.
 */
/** The world is a URL contract, so switching it is a reload, not a flag. */
function swapWorld(search: string) {
  location.href = `${location.pathname}${search}${location.hash}`;
  location.reload();
}

export function DemoMenu() {
  const {
    activeTab,
    sessionById,
    sessions,
    setStatus,
    toggleTheme,
    setPage,
    setDrawer,
    toast,
    dark,
    sourceLabel,
  } = useStore();

  const agentId =
    activeTab?.kind === "session" && sessionById(activeTab.sessionId)?.kind === "agent"
      ? activeTab.sessionId
      : "s-harness";
  const agentName = sessionById(agentId)?.name ?? agentId;

  const runtime = () => sessionRuntime(agentId);

  const flipAll = (status: SessionStatus) => {
    for (const session of sessions) setStatus(session.id, status);
    toast(`Every session set to ${status}`);
  };

  return (
    <MenuRoot
      align="end"
      trigger={
        <button
          type="button"
          className="rise-1 flex h-7 shrink-0 items-center gap-1.5 rounded-chip border border-dashed border-[var(--line-strong)] px-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-52 hover:text-ink"
        >
          <Icon name="sparkles" size={12} />
          Demo
        </button>
      }
    >
      <MenuLabel>Drive {agentName}</MenuLabel>
      <MenuItem
        icon="send"
        onClick={() => runtime().send("¿Por qué el chrome se siente inconsistente?")}
      >
        Stream a reply
      </MenuItem>
      <MenuItem
        icon="circleAlert"
        onClick={() => runtime().sendAndAskApproval("Reescribí index.css con la escala de elevación.")}
      >
        Raise an approval
      </MenuItem>
      <MenuItem icon="listTree" onClick={() => runtime().sendAndAsk("¿Qué escala usamos?")}>
        Ask a question
      </MenuItem>
      <MenuItem icon="users" onClick={() => {
        const pick = LETTERS[Math.floor(Math.random() * LETTERS.length)]!;
        runtime().receiveFrom({ id: pick[0], name: pick[1] }, pick[2]);
      }}>
        Receive a letter
      </MenuItem>
      <MenuItem icon="square" onClick={() => runtime().stop()}>
        Interrupt the turn
      </MenuItem>

      <MenuSep />
      <MenuLabel>Every session</MenuLabel>
      {STATUS_ORDER.map((status) => (
        <MenuItem key={status} icon="circleDot" onClick={() => flipAll(status)}>
          {`Set status: ${status}`}
        </MenuItem>
      ))}

      <MenuSep />
      <MenuLabel>Shell</MenuLabel>
      <MenuItem icon={dark ? "sun" : "moon"} onClick={toggleTheme}>
        {dark ? "Light theme" : "Dark theme"}
      </MenuItem>
      <MenuItem icon="network" onClick={() => setPage({ kind: "agents" })}>
        Agent network
      </MenuItem>
      <MenuItem icon="split" onClick={() => setDrawer({ kind: "diff", path: "src/lib/toolDetail.ts" })}>
        Diff in the drawer
      </MenuItem>

      <MenuSep />
      <MenuLabel>World · {sourceLabel}</MenuLabel>
      <MenuItem icon="layers" onClick={() => swapWorld("?stress=heavy")}>
        Stress · heavy (400 sessions)
      </MenuItem>
      <MenuItem icon="rows" onClick={() => swapWorld("?stress=light")}>
        Stress · light
      </MenuItem>
      <MenuItem icon="server" onClick={() => swapWorld("?source=live")}>
        Live daemon
      </MenuItem>
      <MenuItem icon="refresh" onClick={() => swapWorld("")}>
        Back to the demo fixtures
      </MenuItem>
    </MenuRoot>
  );
}
