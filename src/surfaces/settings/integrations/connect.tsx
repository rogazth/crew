// The connect dialog, the same small frame as a connector's: opened by Install,
// it starts the sign-in at once, one row that moves through its stages, then
// the new account with its name. A server that refuses Crew's sign-in says so
// here, in the daemon's words.
import { AlertCircleIcon, GlobeIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../chrome/kit";
import { AccountName } from "./bits";
import { Dialog, DialogFooter, DialogGroup, DialogHeader, DialogRow } from "./dialog";
import { hostOf, ui } from "./lib";
import { brandOf, brandOfServer, type Brand } from "./brand";
import { ServiceMark } from "./mark";
import { accountOf, actions, connectorOf, useIntegrations, type Account, type FlowStage, type Source } from "./store";

const STAGE: Record<Exclude<FlowStage, "done" | "failed">, string> = {
  opening: "Opening the sign-in window…",
  waiting: "Waiting for the browser…",
  redeeming: "Saving to the vault…",
};

function Glyph({ icon: Icon, tone = "text-icon" }: { icon: LucideIcon; tone?: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface shadow-[0_0_0_1px_var(--color-hairline)]">
      <Icon className={`size-4 ${tone}`} />
    </span>
  );
}

/** What the sheet shows before the connector exists: the registry's entry, or the URL typed. */
function brandOfSource(source: Source): Brand {
  if (source.kind === "registry") return brandOfServer(source.server);
  const host = hostOf(source.url);
  return { id: source.url, name: source.name ?? host, publisher: host, logo: null };
}

export function ConnectDialog({ source }: { source: Source }) {
  const s = useIntegrations();
  const [made, setMade] = useState<{ connectorId: string; flowId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connector = connectorOf(s, made?.connectorId);
  const brand = connector ? brandOf(connector) : brandOfSource(source);
  const flow = s.flows.find((f) => f.id === made?.flowId);
  const account = accountOf(s, flow?.accountId ?? undefined);
  const connected = account?.state === "connected" && (!flow || flow.stage === "done") ? account : null;
  const stage: FlowStage = connected ? "done" : error || flow?.stage === "failed" ? "failed" : (flow?.stage ?? "opening");
  const why = error ?? flow?.error;
  // Closed mid-way, the sign-in goes on, and its tile shows it. Failed, nothing lands: stay where the install began.
  const close = () => (!made ? ui.close() : stage === "failed" ? ui.drop(made.connectorId) : ui.land(made.connectorId));
  const start = async () => {
    setError(null);
    try {
      const next = await actions.installAndConnect(source);
      if (next.installed) ui.hide(next.connectorId);
      setMade({ connectorId: next.connectorId, flowId: next.flowId });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  // Install already asked: the sign-in opens with the sheet, once (StrictMode mounts twice).
  const began = useRef(false);
  useEffect(() => {
    if (began.current) return;
    began.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const title = stage === "done" ? `${brand.name} is installed` : `Install ${brand.name}`;
  return (
    <Dialog label={title}>
      <DialogHeader mark={<ServiceMark brand={brand} size={40} />} title={title} subtitle={connected?.identity ?? brand.publisher} />

      {(stage === "opening" || stage === "waiting" || stage === "redeeming") && (
        <DialogGroup>
          <DialogRow icon={<Glyph icon={GlobeIcon} tone="text-info" />} title={<span className="crew-shimmer">{STAGE[stage]}</span>} />
        </DialogGroup>
      )}

      {stage === "failed" && (
        <DialogGroup>
          <DialogRow icon={<Glyph icon={AlertCircleIcon} tone="text-danger" />} title="Sign-in didn’t finish" subtitle={why} />
        </DialogGroup>
      )}

      {stage === "done" && connected && <Landed account={connected} />}

      <DialogFooter>
        {(stage === "opening" || stage === "waiting" || stage === "redeeming") && (
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
        )}
        {stage === "failed" && (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void start()}>
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
      <DialogRow title={<AccountName account={account} />} subtitle={account.identity ?? undefined} />
    </DialogGroup>
  );
}
