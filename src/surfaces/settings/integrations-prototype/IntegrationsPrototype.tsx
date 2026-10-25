// PROTOTYPE — throwaway. The Integrations page (variant C, the one chosen)
// over three scenarios via ?scenario=fresh|using|offline. Everything runs on
// store.prototype.ts except Browse, which reads crewd's registry copy.
// `?open=integrations` opens the page on load.
import { BracesIcon } from "lucide-react";
import { useState } from "react";
import { ProtoKeyframes } from "./parts.prototype";
import { SCENARIOS, actions, useIntegrations } from "./store.prototype";
import { VariantC } from "./VariantC.prototype";
import { ui, useUi } from "./VariantC.lib.prototype";
import { detailName } from "./VariantC.detail.prototype";

// Opens the page on load when asked, once the rail is up.
if (new URLSearchParams(location.search).get("open") === "integrations") {
  let tries = 0;
  const timer = window.setInterval(() => {
    if (++tries > 20 || document.querySelector("[data-integrations-prototype]")) return window.clearInterval(timer);
    document.querySelector<HTMLElement>('[data-nav][aria-label="Connectors"]')?.click();
  }, 300);
}

/** The page strip's trail: empty on the connectors (the page heads itself), Connectors › Browse on the directory. */
export function useIntegrationsTrail(): (string | { label: string; onClick: () => void })[] {
  const s = useIntegrations();
  const { view, detail } = useUi();
  const back = { label: "Connectors", onClick: () => ui.go("home") };
  if (view === "detail" && detail) return [back, detailName(s, detail)];
  return view === "directory" ? [back, "Browse"] : [];
}

export function IntegrationsPrototype() {
  return (
    <div data-integrations-prototype className="h-full">
      <ProtoKeyframes />
      <VariantC />
      <Switcher />
    </div>
  );
}

function Switcher() {
  const s = useIntegrations();
  const [inspect, setInspect] = useState(false);
  if (!import.meta.env.DEV) return null;
  const summary = {
    scenario: s.scenario,
    vault: s.vault,
    accounts: s.accounts.map((a) => ({ id: a.id, state: a.state, bindings: a.bindings, toolsOff: a.toolsOff })),
    offInCrew: s.servers.filter((x) => x.offInCrew).map((x) => x.id),
    needsSignIn: s.servers.filter((x) => x.state === "needs-auth").map((x) => x.id),
    flows: s.flows.map((f) => `${f.kind}:${f.target}:${f.stage}`),
  };
  return (
    <>
      {inspect && (
        <pre className="fixed bottom-16 left-1/2 z-[95] max-h-[50vh] w-[520px] -translate-x-1/2 overflow-auto rounded-xl bg-[oklch(16%_0_0)] p-3 font-mono text-[10.5px] leading-4 text-[oklch(88%_0_0)] shadow-float">
          {JSON.stringify(summary, null, 2)}
        </pre>
      )}
      <div className="fixed bottom-4 left-1/2 z-[95] flex h-10 -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-[oklch(16%_0_0)] px-1.5 text-[12px] text-[oklch(96%_0_0)] shadow-[0_8px_30px_-6px_oklch(0%_0_0/0.5),0_0_0_1px_oklch(100%_0_0/0.08)]">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.key}
            type="button"
            onClick={() => actions.setScenario(scenario.key)}
            className={`h-7 rounded-full px-2.5 transition-colors ${s.scenario === scenario.key ? "bg-white text-black" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
          >
            {scenario.name}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-white/15" />
        <button
          type="button"
          onClick={() => setInspect((on) => !on)}
          aria-label="Show the state"
          title="Show the state"
          className={`grid size-7 place-items-center rounded-full ${inspect ? "bg-white text-black" : "hover:bg-white/10"}`}
        >
          <BracesIcon className="size-3.5" />
        </button>
      </div>
    </>
  );
}
