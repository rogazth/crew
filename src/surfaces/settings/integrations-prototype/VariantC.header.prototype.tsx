// PROTOTYPE — throwaway. The small orbit the empty shelf shows on first open:
// Crew in the middle, the CLIs' services seeding round it.
import { LockIcon } from "lucide-react";
import { type CSSProperties } from "react";
import { CrewGlyph } from "../../../chrome/CrewGlyph";
import { RAISED } from "../ui";
import { ServiceMark } from "./parts.prototype";
import { serviceOf, useIntegrations, type Service } from "./store.prototype";

/* ── The small orbit ────────────────────────────────────────────────── */

const SIZE = 168;
const C = SIZE / 2;
const R = 66;

/** Crew with the vault's lock, and the services the CLIs already have, seeding one by one and turning slowly. */
export function MiniOrbit() {
  const s = useIntegrations();
  const found = [...new Set(s.servers.map((x) => x.serviceId).filter((x): x is string => !!x))].map(serviceOf).filter((x): x is Service => !!x);
  return (
    <div aria-hidden className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0">
        <circle cx={C} cy={C} r={R} fill="none" strokeWidth="1" strokeDasharray="2 5" className="stroke-border-strong" />
      </svg>
      <div className="absolute inset-0 motion-safe:animate-[c-orbit_120s_linear_infinite]">
        {found.map((service, i) => {
          const angle = -Math.PI / 2 + (i / found.length) * Math.PI * 2;
          const style: CSSProperties = { left: C + R * Math.cos(angle) - 12, top: C + R * Math.sin(angle) - 12 };
          return (
            <div key={service.id} className="absolute size-6" style={style}>
              <div className="size-full motion-safe:animate-[c-unorbit_120s_linear_infinite]">
                <ServiceMark service={service} size={24} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="absolute" style={{ left: C - 26, top: C - 26 }}>
        <span className={`grid size-[52px] place-items-center rounded-[16px] ${RAISED}`}>
          <CrewGlyph className="size-8" />
        </span>
        <span className="absolute -right-1.5 -bottom-1.5 grid size-6 place-items-center rounded-full bg-surface shadow-[0_0_0_1px_var(--color-hairline)]">
          <LockIcon className="size-3 text-success" />
        </span>
      </div>
    </div>
  );
}
