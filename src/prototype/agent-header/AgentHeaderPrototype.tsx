// PROTOTYPE — throwaway. Variants of the subagent thread's header (the real
// one is src/surfaces/chat/AgentView.tsx; plan docs/plans/2026-10-12-orchestration-ui.md,
// decisions 10–16), each drawn over four threads: the reported case, a running
// writable session, a grandchild, and long names.
// Run: `CREW_PORT=1430 npx vite --open "/?prototype=agent-header"`. `?variant=` picks one, `?theme=light|dark` forces a theme.
import { useEffect, useState } from "react";
import { Segmented } from "../../chrome/kit";
import { PrototypeSwitcher } from "../PrototypeSwitcher";
import { CASES } from "./data";
import { VARIANTS } from "./variants";

type Theme = "system" | "light" | "dark";

function useParam<T extends string>(name: string, fallback: T) {
  const [value, setValue] = useState<T>(() => (new URLSearchParams(location.search).get(name) as T | null) ?? fallback);
  const change = (next: T) => {
    const url = new URL(location.href);
    url.searchParams.set(name, next);
    history.replaceState(null, "", url);
    setValue(next);
  };
  return [value, change] as const;
}

export function AgentHeaderPrototype() {
  const [variant, setVariant] = useParam<string>("variant", "A");
  const [theme, setTheme] = useParam<Theme>("theme", "system");
  useEffect(() => {
    document.documentElement.style.colorScheme = theme === "system" ? "" : theme;
  }, [theme]);
  const current = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0]!;
  const Current = current.Component;
  return (
    <div className="min-h-screen bg-sidebar px-6 pt-5 pb-20 text-text">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-[15px] font-medium">
          Thread header · {current.key} <span className="text-text-muted">— {current.name}</span>
        </h1>
        <span className="flex-1" />
        <Segmented<Theme>
          value={theme}
          label="Theme"
          onChange={setTheme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-4">
        {CASES.map((c) => (
          <section key={c.key} className="flex min-w-0 flex-col gap-1.5">
            <h2 className="text-[12px] text-text-muted">{c.label}</h2>
            <Current c={c} />
          </section>
        ))}
      </div>
      <PrototypeSwitcher variants={VARIANTS} current={current.key} onChange={setVariant} />
    </div>
  );
}
