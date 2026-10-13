// PROTOTYPE — throwaway. Four variants of the chat redesign (plan
// docs/plans/2026-10-07-chat-over-protocol.md, decisions 16 and 28–36),
// switchable with `?variant=`, on a fake session that works by itself.
// Run: `npm run prototype:chat`. It never talks to crewd.
import { useState } from "react";
import { PrototypeSwitcher } from "../PrototypeSwitcher";
import { ScenarioBar, StateReadout } from "./parts";
import { useSim } from "./sim";
import { VARIANTS } from "./variants";

export function ChatRedesignPrototype() {
  const sim = useSim();
  const [variant, setVariant] = useState(() => new URLSearchParams(location.search).get("variant") ?? "E");
  const change = (key: string) => {
    const url = new URL(location.href);
    url.searchParams.set("variant", key);
    history.replaceState(null, "", url);
    setVariant(key);
  };
  const Current = (VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0]).Component;
  return (
    <div className="flex h-screen flex-col bg-canvas pt-12 pb-14 text-text">
      <Current sim={sim} />
      <ScenarioBar sim={sim} />
      <StateReadout sim={sim} />
      <PrototypeSwitcher variants={VARIANTS} current={variant} onChange={change} />
    </div>
  );
}
