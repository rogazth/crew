// PROTOTYPE — throwaway. Variant C's vault sheet: the machines, the vault
// starred and checked among them. Picking another one wakes Move vault; the
// star follows when it's done.
import { CheckIcon, LockIcon, StarIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../chrome/kit";
import { MachineGlyph } from "./parts.prototype";
import { Dialog, DialogFooter, DialogGroup, DialogHeader } from "./VariantC.dialog.prototype";
import { plural, ui, useEscape } from "./VariantC.lib.prototype";
import { actions, machineOf, useIntegrations, type Machine, type MachineId } from "./store.prototype";

export function VaultSheet() {
  const s = useIntegrations();
  const [target, setTarget] = useState<MachineId>(s.vault.machine);
  const [retrying, setRetrying] = useState(false);
  const moving = s.flows.some((f) => f.kind === "vault-move" && f.stage !== "done" && f.stage !== "failed");
  const vault = machineOf(s, s.vault.machine);
  const offline = s.vault.state === "offline";
  const changed = target !== s.vault.machine;
  const retry = () => {
    setRetrying(true);
    window.setTimeout(() => {
      actions.vaultBack();
      setRetrying(false);
    }, 1400);
  };
  useEscape(ui.close);
  return (
    <Dialog label="Vault">
      <DialogHeader
        mark={
          <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-card">
            <LockIcon className="size-5 text-icon" />
          </span>
        }
        title="Vault"
        subtitle="Where Crew stores your sign-ins."
      />
      <DialogGroup>
        {s.machines.map((m) => (
          machineRow(m, m.id === target, moving || !m.online, () => setTarget(m.id))
        ))}
      </DialogGroup>
      {/* Moving off an offline vault can't take the sign-ins along: the one thing worth saying before the move. */}
      {changed && !moving && offline && <p className="-mt-2 px-5 pb-5 text-[12.5px] text-text-muted">You’ll sign in to {plural(s.accounts.length, "account")} again.</p>}
      <DialogFooter>
        {offline && !changed && (
          <Button variant="ghost" loading={retrying} onClick={retry}>
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        )}
        <Button variant="primary" loading={moving} disabled={!changed || moving} onClick={() => actions.moveVault(target)}>
          {moving ? "Moving…" : "Move vault"}
        </Button>
      </DialogFooter>
    </Dialog>
  );

  /** Where it stands: the vault, or how long its lease has left. */
  function statusOf(m: Machine): string {
    if (m.id === vault.id) return offline ? `Current vault · Offline since ${s.vault.offlineSince}` : "Current vault";
    if (!m.online) return "Offline";
    const lease = s.vault.lessees.find((l) => l.machine === m.id)?.leaseMinutes;
    if (lease === undefined) return "Not connected";
    // Online, leases renew on their own; only an offline vault makes them count down.
    if (!offline) return "Connected";
    return lease === 0 ? "Stopped" : `Stops in ${lease} min`;
  }

  function machineRow(machine: Machine, picked: boolean, disabled: boolean, onPick: () => void) {
    const down = machine.id === vault.id && offline;
    return (
      <button
        key={machine.id}
        type="button"
        role="radio"
        aria-checked={picked}
        disabled={disabled}
        onClick={onPick}
        className="flex h-14 w-full items-center gap-2.5 border-t border-hairline text-left outline-none first:border-t-0 focus-visible:bg-hover disabled:cursor-default"
      >
        <span className="relative ml-1 flex shrink-0">
          <MachineGlyph machine={machine} className={`size-4 text-icon ${machine.online ? "" : "opacity-45"}`} />
          {down && <span className="absolute -right-[3px] -bottom-[3px] size-2 rounded-full bg-warning ring-2 ring-card" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`flex items-center gap-1.5 font-medium ${machine.online ? "" : "text-text-muted"}`}>
            {machine.name}
            {machine.id === vault.id && <StarIcon aria-label="Current vault" className="size-3 fill-current text-icon" />}
          </span>
          <span className="truncate text-[12px] text-text-muted">{statusOf(machine)}</span>
        </span>
        <span className={`mr-1 grid size-4 shrink-0 place-items-center rounded-full transition-colors ${picked ? "bg-text text-inverse" : "ring-1 ring-border-strong"}`}>
          {picked && <CheckIcon className="size-2.5" strokeWidth={3} />}
        </span>
      </button>
    );
  }
}
