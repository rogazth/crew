// PROTOTYPE — throwaway. Where the vault shows on the connectors page: one
// quiet line at the end of Installed's title, since it's those connectors'
// sign-ins it keeps, and nothing at all before there's one. Offline it says
// so in a word and an amber dot, no red, no countdown: the tiles already say
// which connectors are paused, and the sheet a click opens has Retry and Move.
import { LoaderCircleIcon, LockIcon } from "lucide-react";
import { useFresh } from "./parts.prototype";
import { Dot } from "./VariantC.bits.prototype";
import { ui } from "./VariantC.lib.prototype";
import { machineOf, useIntegrations, type MachineId } from "./store.prototype";

export function VaultLine() {
  const s = useIntegrations();
  const glow = useFresh("vault");
  const flow = s.flows.find((f) => f.kind === "vault-move" && f.stage !== "done" && f.stage !== "failed");
  const name = machineOf(s, s.vault.machine).name;
  const offline = s.vault.state === "offline";
  const to = flow ? machineOf(s, flow.target as MachineId).name : undefined;
  return (
    <button
      type="button"
      onClick={() => ui.open({ kind: "vault" })}
      title={offline ? `The vault on ${name} is offline` : `Sign-ins are stored in the vault on ${name}`}
      className={`-mr-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] font-medium text-text-muted outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 ${glow}`}
    >
      {to ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : offline ? <Dot tone="warning" className="mx-1 size-1.5" /> : <LockIcon className="size-3.5" />}
      {to ? `Moving to ${to}…` : offline ? `Can’t reach ${name}` : `Stored on ${name}`}
    </button>
  );
}
