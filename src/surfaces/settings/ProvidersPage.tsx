// Providers: the default agent for new sessions (provider, model, effort) and
// what it may do without asking, then one card per CLI on the machine picked,
// with its version, account and the jobs that install, update and sign it in.
import { CheckIcon, FilePenLineIcon, HandIcon, SparklesIcon, ZapIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ProviderList } from "./ProviderList";
import { PROVIDER_META } from "./providerMeta";
import { Select } from "../../chrome/kit";
import { ModelPicker } from "../../chrome/ModelPicker";
import { useDefaultAgent } from "../../hooks/useDefaultAgent";
import * as api from "../../lib/api";
import { sessionAccess } from "../../lib/permissions";
import { setSetting } from "../../lib/settingsEngine/store";
import {
  ACCESSES,
  EFFORT_LABELS,
  accessesOf,
  effortsOf,
  fitChoice,
  listedModelsVersion,
  loadListedModels,
  providerOf,
  subscribeListedModels,
  type Access,
} from "../../lib/providers";
import { ConfirmDialog, Heading, Row, SettingsPage, toast, type ConfirmAsk } from "./ui";

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
  // The CLI's own model list replaces Crew's once it is read.
  useSyncExternalStore(subscribeListedModels, listedModelsVersion);
  useEffect(() => {
    loadListedModels(preferred.provider, api.listedModels);
  }, [preferred.provider]);
  // Only what can start a session is a choice; with nothing installed there is nothing to prefer.
  if (installed.length === 0) return null;
  const efforts = effortsOf(preferred.provider, preferred.model);
  return (
    <section className="flex flex-col gap-2" data-setting="default-agent">
      <Heading title="Preferred model" description="Default for new sessions and bots." />
      <div className="rounded-xl bg-card px-4" data-setting="default-model">
        <Row label="Model" description="What a new session runs on.">
          <div className="w-56">
            <ModelPicker
              provider={preferred.provider}
              model={preferred.provider === "opencode" ? fitChoice(preferred).model : preferred.model}
              // Another provider's model brings that provider's last effort and tier along.
              onChange={(provider, model) => update(fitChoice({ ...lastOf(provider), provider, model, access: preferred.access }))}
            />
          </div>
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
    </section>
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

/** What every session and bot may do without asking: four tiles that never change size, whichever is picked. */
function Permissions() {
  const { preferred, update, setDraft } = useDefaultAgent();
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);
  const supported = accessesOf(preferred.provider);
  const name = PROVIDER_META[preferred.provider].name;

  const apply = (access: Access) => {
    update({ ...preferred, access });
    // A composer's earlier pick would start the next session on the old access.
    setDraft(null);
    setSetting(sessionAccess, access).catch((error: unknown) =>
      toast(`Could not save: ${error instanceof Error ? error.message : String(error)}`, "danger"),
    );
  };
  const choose = (access: Access) => {
    if (access === preferred.access) return;
    if (access !== "full") return apply(access);
    setAsk({
      title: "Give every session full access?",
      description: "Agents on all your machines edit files and run commands without asking, from their next turn.",
      action: "Give full access",
      onConfirm: () => apply("full"),
    });
  };

  return (
    <section className="flex flex-col gap-2" data-setting="access">
      <Heading title="Permissions" />
      <div role="radiogroup" aria-label="Access for every session" className="grid grid-cols-2 gap-2 @[620px]:grid-cols-4">
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
              onClick={() => choose(a.id)}
              className={`group flex flex-col gap-2.5 rounded-xl p-3 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 disabled:cursor-default ${
                on
                  ? "bg-card shadow-[inset_0_0_0_1.5px_var(--color-text)]"
                  : "bg-card shadow-[0_0_0_1px_var(--color-hairline)] enabled:hover:bg-hover"
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
      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </section>
  );
}
