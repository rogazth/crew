// PROTOTYPE — throwaway. Variant C's connect dialog, the same small frame as
// a connector's: what will happen and one button, the sign-in as one row that
// moves through its stages, then the new account with its name. Adding another account and moving a CLI's server to
// Crew are the same dialog with other words.
import { AlertCircleIcon, ArrowUpRightIcon, GlobeIcon, LoaderCircleIcon, LockIcon, VenetianMaskIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../chrome/kit";
import { ServiceMark } from "./parts.prototype";
import { AccountName } from "./VariantC.bits.prototype";
import { Dialog, DialogFooter, DialogGroup, DialogHeader, DialogRow } from "./VariantC.dialog.prototype";
import { ui } from "./VariantC.lib.prototype";
import { PROVIDER_NAMES, actions, machineOf, serviceOf, useIntegrations, type Account, type FlowStage } from "./store.prototype";

const STAGE: Record<Exclude<FlowStage, "done" | "failed">, string> = {
  opening: "Opening the sign-in tab…",
  waiting: "Waiting for the browser…",
  redeeming: "Saving to the vault…",
};

function Glyph({ icon: Icon, tone = "text-icon", spin = false }: { icon: LucideIcon; tone?: string; spin?: boolean }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface shadow-[0_0_0_1px_var(--color-hairline)]">
      <Icon className={`size-4 ${tone} ${spin ? "animate-spin" : ""}`} />
    </span>
  );
}

export function ConnectDialog({ serviceId, moveFrom }: { serviceId: string; moveFrom?: string | undefined }) {
  const s = useIntegrations();
  const service = serviceOf(serviceId);
  const [made, setMade] = useState<string | null>(null);
  // Whether there was an account before this one: the sign-in then runs in a private tab.
  const [first] = useState(() => s.accounts.find((a) => a.serviceId === serviceId));
  if (!service) return null;
  const vault = machineOf(s, s.vault.machine);
  const account = s.accounts.find((a) => a.id === made);
  const flow = s.flows.find((f) => f.kind === "account" && f.target === made);
  const stage: FlowStage | "idle" = !made ? "idle" : account ? "done" : (flow?.stage ?? "opening");
  const source = s.servers.find((x) => x.id === moveFrom);
  const close = () => (made ? ui.land(made) : ui.close());
  const start = () => {
    const id = actions.connect(serviceId);
    if (!id) return;
    setMade(id);
    ui.hide(id);
    // Moving a CLI's server: once Crew has the account, the CLI's copies leave Crew's sessions.
    if (moveFrom) window.setTimeout(() => actions.keepCrews(serviceId), 3000);
  };
  const title =
    stage === "done" ? `${service.name} is installed` : first ? `Add a ${service.name} account` : moveFrom ? `Move ${service.name} to Crew` : `Install ${service.name}`;
  return (
    <Dialog label={title}>
      <DialogHeader mark={<ServiceMark service={service} size={40} />} title={title} subtitle={account ? account.identity : service.publisher} />

      {stage === "idle" && (
        <DialogGroup>
          <DialogRow
            icon={<Glyph icon={first ? VenetianMaskIcon : ArrowUpRightIcon} />}
            title={`Authenticate with ${service.name}`}
            subtitle={first ? "In a private tab" : "In Crew’s browser"}
          />
          <DialogRow icon={<Glyph icon={LockIcon} />} title={`Kept in the vault on ${vault.name}`} />
          {source && (
            <DialogRow
              icon={<Glyph icon={GlobeIcon} />}
              title={`${PROVIDER_NAMES[source.provider]}’s copy gets disabled`}
            />
          )}
        </DialogGroup>
      )}

      {(stage === "opening" || stage === "waiting" || stage === "redeeming") && (
        <DialogGroup>
          <DialogRow icon={<Glyph icon={LoaderCircleIcon} tone="text-info" spin />} title={STAGE[stage]} />
        </DialogGroup>
      )}

      {stage === "failed" && (
        <DialogGroup>
          <DialogRow icon={<Glyph icon={AlertCircleIcon} tone="text-danger" />} title="Sign-in didn’t finish" />
        </DialogGroup>
      )}

      {stage === "done" && account && <Landed account={account} />}

      <DialogFooter>
        {stage === "idle" && (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={start}>
              Authenticate
            </Button>
          </>
        )}
        {(stage === "opening" || stage === "waiting" || stage === "redeeming") && (
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
        )}
        {stage === "failed" && (
          <>
            <Button variant="ghost" onClick={ui.close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={start}>
              Try again
            </Button>
          </>
        )}
        {stage === "done" && (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/** The new account and its name. */
function Landed({ account }: { account: Account }) {
  return (
    <DialogGroup title="Account">
      <DialogRow title={<AccountName account={account} />} subtitle={account.identity} />
    </DialogGroup>
  );
}
