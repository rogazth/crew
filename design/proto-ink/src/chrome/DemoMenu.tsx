import { STRESS_PRESETS, sessionRuntime } from "@crew/fixtures";
import type { SessionStatus, StressPreset } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { SOURCE, threadOf } from "@/lib/source";
import { useApp } from "@/lib/store";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuPrimitive, MenuRadioItem } from "@/ui";

const LETTERS: Array<[string, string, string]> = [
  [
    "s-relay",
    "Relay",
    "El editor de rutinas ya toma el agente del workspace activo. ¿Te sirve o lo quiero demasiado mágico?",
  ],
  [
    "s-renderer",
    "renderer",
    "Subí el shell a la escala de elevación nueva. Los botones dejaron de pelearse con el sidebar.",
  ],
  [
    "s-scribe",
    "scribe",
    "Documenté el contrato de bloques. Te dejé tres preguntas al final del doc, las tres son de naming.",
  ],
];

const STATUSES: SessionStatus[] = ["idle", "working", "needs-input", "done", "error"];

/** Switching mode is a reload, because the source is decided once at boot. */
function go(search: string) {
  window.location.href = `${location.pathname}${search}${location.hash}`;
}

/**
 * A dev affordance, deliberately marked as one. Streaming goes through the same
 * `DataSource` the composer uses, so it works in every mode — including against
 * a live daemon. The scripted approval, question and letter are the mock's own
 * and are offered only where the mock is what is answering.
 */
export function DemoMenu() {
  const { sessions, activeTab, activeWorkspaceId, actions, theme } = useApp();

  const target =
    (activeTab?.kind === "session" &&
      sessions.find((s) => s.id === activeTab.sessionId && s.kind === "agent")) ||
    sessions.find((s) => s.workspaceId === activeWorkspaceId && s.kind === "agent") ||
    sessions[0];

  // The scripted turns live on `MockSession`, which only backs a demo-fixture id.
  const scriptable =
    target !== undefined && SOURCE.kind === "fixtures" && !target.id.startsWith("stress-s-");
  const mock = () => sessionRuntime(target!.id, target!.status);

  const flip = (status: SessionStatus) => {
    for (const session of sessions) {
      if (session.workspaceId !== activeWorkspaceId) continue;
      actions.setStatus(session.id, status);
    }
  };

  return (
    <Menu
      align="end"
      width={258}
      trigger={
        <button
          type="button"
          aria-label="Demo menu"
          className={cx(
            "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro",
            "bg-[var(--attention-fill)] text-[var(--status-attention)]",
            "transition-opacity duration-[var(--dur-2)] hover:opacity-80",
          )}
        >
          <Icon name="flask" size={13} />
          Demo
        </button>
      }
    >
      <MenuLabel>Drive {target?.name ?? "an agent"}</MenuLabel>
      <MenuItem
        icon="send"
        disabled={!target}
        onClick={() => {
          if (!target) return;
          actions.openSession(target.id);
          void threadOf(target.id).send("¿Por qué el chrome se siente inconsistente?");
        }}
      >
        Stream a reply
      </MenuItem>
      <MenuItem
        icon="check"
        disabled={!scriptable}
        onClick={() => {
          actions.openSession(target!.id);
          mock().sendAndAskApproval("Reescribí index.css con la escala nueva.");
        }}
      >
        Raise an approval
      </MenuItem>
      <MenuItem
        icon="message"
        disabled={!scriptable}
        onClick={() => {
          actions.openSession(target!.id);
          mock().sendAndAsk("¿Qué escala de elevación usamos?");
        }}
      >
        Raise a question
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Inbound letter</MenuLabel>
      {LETTERS.map(([id, name, text]) => (
        <MenuItem
          key={id}
          icon="mail"
          disabled={!scriptable}
          onClick={() => {
            actions.openSession(target!.id);
            mock().receiveFrom({ id, name }, text);
            actions.setStatus(target!.id, "needs-input");
          }}
        >
          From {name}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Every session</MenuLabel>
      {STATUSES.map((status) => (
        <MenuItem key={status} icon="activity" onClick={() => flip(status)}>
          Set all to {status}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Data source</MenuLabel>
      <MenuItem icon="package" hint={SOURCE.label === "Fixtures" ? "current" : ""} onClick={() => go("")}>
        Demo fixtures
      </MenuItem>
      {(Object.keys(STRESS_PRESETS) as StressPreset[]).map((preset) => (
        <MenuItem
          key={preset}
          icon="layers"
          hint={`${STRESS_PRESETS[preset].blocks} blocks`}
          onClick={() => go(`?stress=${preset}`)}
        >
          Stress · {preset}
        </MenuItem>
      ))}
      <MenuItem icon="cpu" onClick={() => go("?source=live")}>
        Live daemon
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Theme</MenuLabel>
      <MenuPrimitive.RadioGroup
        value={theme}
        onValueChange={(next: unknown) => actions.setTheme(next as "light" | "dark" | "system")}
      >
        <MenuRadioItem value="light">Light</MenuRadioItem>
        <MenuRadioItem value="dark">Dark</MenuRadioItem>
        <MenuRadioItem value="system">System</MenuRadioItem>
      </MenuPrimitive.RadioGroup>
    </Menu>
  );
}

/** What is answering, and whether it still is. */
export function SourceBadge() {
  const { connected, ready } = useApp();
  const live = SOURCE.kind === "live";
  const down = live && !connected;
  return (
    <span
      title={live ? (connected ? "Connected to crewd" : "The daemon is not answering") : SOURCE.label}
      className={cx(
        "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-micro",
        down ? "bg-[var(--danger-fill)] text-[var(--status-danger)]" : "text-quaternary",
      )}
    >
      <span
        className="ink-dot"
        data-status={down ? "error" : !ready ? "working" : "done"}
        style={
          {
            "--dot": down
              ? "var(--status-danger)"
              : !ready
                ? "var(--status-attention)"
                : "var(--accent)",
            width: 6,
            height: 6,
          } as React.CSSProperties
        }
      >
        {!ready && !down && <span className="ink-dot-halo" />}
        <span className="ink-dot-core" style={{ width: 6, height: 6 }} />
      </span>
      {SOURCE.label}
    </span>
  );
}
