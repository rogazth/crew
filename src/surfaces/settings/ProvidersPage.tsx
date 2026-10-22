// Providers: the default agent for new sessions (provider, model, effort) and
// what it may do without asking, then one card per CLI on the machine picked,
// with its version, account and the jobs that install, update and sign it in.
import { CheckIcon, FilePenLineIcon, HandIcon, SparklesIcon, ZapIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ProviderList } from "./ProviderList";
import { PROVIDER_META } from "./providerMeta";
import { Select } from "../../chrome/kit";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { useDefaultAgent } from "../../hooks/useDefaultAgent";
import * as api from "../../lib/api";
import { READS, useRead } from "../../lib/settingsReads";
import {
  ACCESSES,
  EFFORT_LABELS,
  accessesOf,
  effortsOf,
  findModel,
  fitChoice,
  listedModelsVersion,
  loadListedModels,
  modelsOf,
  providerOf,
  subscribeListedModels,
  type Access,
  type ProviderDef,
} from "../../lib/providers";
import { Heading, Row, SettingsPage } from "./ui";

export function ProvidersPage({ onOpenTerminal }: { onOpenTerminal: (envId: string, input?: string) => Promise<void> }) {
  // A job that ended on any machine: the list of CLIs on this Mac may have changed.
  const [settled, setSettled] = useState(0);
  return (
    <SettingsPage title="Providers">
      <Permissions />
      <DefaultAgent refresh={settled} />
      <ProviderList onOpenTerminal={onOpenTerminal} onSettled={() => setSettled((n) => n + 1)} />
    </SettingsPage>
  );
}

/* ── Default agent ──────────────────────────────────────────────────── */

function DefaultAgent({ refresh }: { refresh: number }) {
  const { preferred, update, lastOf, installed } = useDefaultAgent(refresh);
  // The provider is the choice; model, effort and tier ride along from its last use.
  const pick = (p: ProviderDef) => update(fitChoice({ ...lastOf(p.id), provider: p.id, access: preferred.access }));
  const current = installed.find((p) => p.id === preferred.provider);
  // Only what can start a session is a choice; with nothing installed there is nothing to prefer.
  if (installed.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-setting="default-agent">
      <Heading title="Preferred agent" description="Default for new sessions and bots." />
      {/* One row of equal cards however many CLIs are installed, so none sits alone below. */}
      <div className="grid grid-cols-2 gap-2 @[620px]:grid-flow-col @[620px]:auto-cols-fr @[620px]:grid-cols-none">
        {installed.map((p) => {
          const on = p.id === preferred.provider;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => pick(p)}
              className={`group flex flex-col gap-2.5 rounded-xl p-3 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 ${
                on
                  ? "bg-card shadow-[inset_0_0_0_1.5px_var(--color-text)]"
                  : "bg-card shadow-[0_0_0_1px_var(--color-hairline)] hover:bg-hover"
              }`}
            >
              <span className="flex items-center justify-between">
                <ProviderIcon provider={p.id} className="size-5" />
                <span
                  className={`grid size-4 place-items-center rounded-full transition-colors ${
                    on ? "bg-text text-inverse" : "ring-1 ring-border-strong"
                  }`}
                >
                  {on && <CheckIcon className="size-2.5" strokeWidth={3} />}
                </span>
              </span>
              <span className="truncate font-medium">{PROVIDER_META[p.id].name}</span>
            </button>
          );
        })}
      </div>
      {current && <ModelAndEffort />}
    </section>
  );
}

/** The model and effort a new session of the preferred agent starts with. */
function ModelAndEffort() {
  const { preferred, update } = useDefaultAgent();
  // The CLI's own model list replaces Crew's once it is read.
  useSyncExternalStore(subscribeListedModels, listedModelsVersion);
  useEffect(() => {
    loadListedModels(preferred.provider, api.listedModels);
  }, [preferred.provider]);
  const models = modelsOf(preferred.provider);
  const model = findModel(preferred.provider, preferred.model)?.id ?? preferred.model;
  const efforts = effortsOf(preferred.provider, preferred.model);
  const options = models.map((m) => ({ value: m.id, label: m.label }));
  if (!options.some((o) => o.value === model)) options.unshift({ value: model, label: model || "CLI default" });
  return (
    <div className="rounded-xl bg-card px-4" data-setting="default-model">
      <Row label="Model" description="What a new session runs on.">
        <Select
          label="Default model"
          value={model}
          options={options}
          className="w-56"
          onChange={(next) => update(fitChoice({ ...preferred, model: next }))}
        />
      </Row>
      {efforts.length > 0 && (
        <div className="border-t border-hairline">
          <Row label="Effort" description="How hard it thinks.">
            <Select
              label="Default effort"
              value={preferred.effort}
              options={[
                ...(providerOf(preferred.provider)?.cliEffort ? [{ value: "" as const, label: "CLI default" }] : []),
                ...efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] })),
              ]}
              className="w-56"
              onChange={(next) => update(fitChoice({ ...preferred, effort: next }))}
            />
          </Row>
        </div>
      )}
    </div>
  );
}

/* ── Permissions ────────────────────────────────────────────────────── */

const ACCESS_ICONS: Record<Access, LucideIcon> = {
  ask: HandIcon,
  edits: FilePenLineIcon,
  auto: SparklesIcon,
  full: ZapIcon,
};

/** The tiles' own words: short enough for two lines at their narrowest. */
const ACCESS_HINTS: Record<Access, string> = {
  ask: "Asks before edits and commands.",
  edits: "Edits freely, asks for commands.",
  auto: "Asks only when risky.",
  full: "Never asks.",
};

/**
 * What a new session may do without asking: four tiles that never change
 * size, whichever is picked, and the bypass that overrides them all under them.
 */
function Permissions() {
  const { preferred, update } = useDefaultAgent();
  // Bypass lives in General; it is read here only to say it overrides the tiles.
  const bypass = useRead(READS.bypass)?.trim() === "on";
  const supported = accessesOf(preferred.provider);
  const name = PROVIDER_META[preferred.provider].name;

  return (
    <section className="flex flex-col gap-2" data-setting="access">
      <Heading title="Permissions" />
      <div className="rounded-xl bg-card p-1.5">
        {bypass && (
          <p className="px-2.5 py-2 text-[12px] text-text-muted">Bypass permissions is on in General: every session runs without asking.</p>
        )}
        {!bypass && (
          <div className="flex flex-col gap-2 px-1 py-1">
            <p className="px-1.5 text-[12px] font-medium text-text-muted">Default access</p>
            <div role="radiogroup" aria-label="Access for new sessions" className="grid grid-cols-2 gap-2 @[620px]:grid-cols-4">
              {ACCESSES.map((a) => {
                const on = a.id === preferred.access;
                const off = !supported.includes(a.id);
                const Icon = ACCESS_ICONS[a.id];
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={off}
                    title={off ? `Not supported by ${name}` : undefined}
                    onClick={() => update({ ...preferred, access: a.id })}
                    className={`group flex flex-col gap-2.5 rounded-xl p-3 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 disabled:cursor-default ${
                      on
                        ? "bg-surface shadow-[inset_0_0_0_1.5px_var(--color-text)]"
                        : "bg-surface shadow-[0_0_0_1px_var(--color-hairline)] enabled:hover:bg-hover"
                    }`}
                  >
                    <span className="flex items-center justify-between">
                      <Icon className={`size-4 ${on ? "text-text" : off ? "text-placeholder" : "text-icon"}`} />
                      <span
                        className={`grid size-4 place-items-center rounded-full transition-colors ${
                          on ? "bg-text text-inverse" : "ring-1 ring-border-strong group-disabled:opacity-0"
                        }`}
                      >
                        {on && <CheckIcon className="size-2.5" strokeWidth={3} />}
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className={`truncate font-medium ${off ? "text-text-muted" : ""}`}>{a.label}</span>
                      {/* Two lines, always: a short description never pulls the row up. */}
                      <span className="line-clamp-2 min-h-[2lh] text-[12px] text-text-muted">
                        {off ? `Not on ${name}` : ACCESS_HINTS[a.id]}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
