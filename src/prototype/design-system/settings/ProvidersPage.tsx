// PROTOTYPE — throwaway. Providers: the default agent for new sessions and
// what it may do without asking (bypass included), then one card per CLI with
// its version, account and defaults. Install, update and sign-in are
// simulated (mock.ts).
import { CheckIcon, FilePenLineIcon, HandIcon, RefreshCwIcon, SparklesIcon, ZapIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ProviderList } from "./ProviderList";
import { Button } from "../../../chrome/kit";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { useDefaultAgent } from "../../../hooks/useDefaultAgent";
import * as api from "../../../lib/api";
import { BYPASS_KEY } from "../../../lib/permissions";
import { ACCESSES, accessesOf, fitChoice, type Access, type ProviderId } from "../../../lib/providers";
import { checkAll, syncInstalled, useChecking, useProviders, type ProviderMock } from "./mock";
import { ConfirmDialog, Heading, SettingsPage, ToggleRow, toast, type ConfirmAsk } from "./ui";

export function ProvidersPage({ installed }: { installed?: ProviderId[] | undefined }) {
  const providers = useProviders();
  const checking = useChecking();
  const key = installed?.join(",");
  useEffect(() => {
    if (key !== undefined) syncInstalled(key ? (key.split(",") as ProviderId[]) : []);
  }, [key]);

  const check = () =>
    void checkAll().then((updates) =>
      toast(
        updates === 0 ? "All up to date" : `${updates} update${updates === 1 ? "" : "s"} available`,
        updates === 0 ? "success" : "info",
      ),
    );

  return (
    <SettingsPage
      title="Providers"
      actions={
        <Button variant="ghost" icon={RefreshCwIcon} loading={checking} onClick={check}>
          Check updates
        </Button>
      }
    >
      <Permissions providers={providers} />
      <DefaultAgent providers={providers} />
      <ProviderList />
    </SettingsPage>
  );
}

/* ── Default agent ──────────────────────────────────────────────────── */

function DefaultAgent({ providers }: { providers: ProviderMock[] }) {
  const { preferred, update } = useDefaultAgent();
  // The provider is the choice; model and effort ride along from its last use.
  const pick = (p: ProviderMock) => update(fitChoice({ provider: p.id, model: p.model, effort: p.effort, access: preferred.access }));
  const current = providers.find((p) => p.id === preferred.provider);
  // Only what can start a session is a choice; with nothing installed there is nothing to prefer.
  const installed = providers.filter((p) => p.version);
  if (installed.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-setting="default-agent">
      <Heading title="Preferred agent" description="Default for new sessions and bots." />
      <div className="grid grid-cols-2 gap-2 @[620px]:grid-cols-4">
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
                  ? "bg-accent/10 shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-accent)_55%,transparent)]"
                  : "bg-card hover:bg-hover"
              }`}
            >
              <span className="flex items-center justify-between">
                <ProviderIcon provider={p.id} className="size-5" />
                <span
                  className={`grid size-4 place-items-center rounded-full transition-colors ${
                    on ? "bg-accent text-inverse" : "ring-1 ring-border-strong"
                  }`}
                >
                  {on && <CheckIcon className="size-2.5" strokeWidth={3} />}
                </span>
              </span>
              <span className="truncate font-medium">{p.name}</span>
            </button>
          );
        })}
      </div>
      {current && !current.account && (
        <p className="px-2.5 text-[12px] text-warning">
          {current.name} is signed out.
        </p>
      )}
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

/**
 * What a new session may do without asking: four tiles that never change
 * size, whichever is picked, and the bypass that overrides them all under them.
 */
function Permissions({ providers }: { providers: ProviderMock[] }) {
  const { preferred, update } = useDefaultAgent();
  const [bypass, setBypass] = useState(false);
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);
  const supported = accessesOf(preferred.provider);
  const name = providers.find((p) => p.id === preferred.provider)?.name ?? "This provider";

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(BYPASS_KEY)
      .then((raw) => !cancelled && setBypass(raw?.trim() === "on"))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveBypass = (next: boolean) => {
    setBypass(next);
    void (next ? api.stateSet(BYPASS_KEY, "on") : api.stateDelete(BYPASS_KEY)).catch(() => {});
  };

  return (
    <section className="flex flex-col gap-2" data-setting="access">
      <Heading title="Permissions" />
      {/* One card, one permission: the bypass switch, and under it the access new sessions start with, while it's off. */}
      <div className="rounded-xl bg-card p-1.5">
        <div className="px-2.5">
          <ToggleRow
            id="bypass"
            label="Bypass permissions"
            description={
              bypass
                ? "All sessions run without asking."
                : "Sessions use their own access level."
            }
            checked={bypass}
            onChange={(next) =>
              next
                ? setAsk({
                    title: "Bypass permissions?",
                    description: "All agents will edit and run commands without asking.",
                    action: "Bypass",
                    onConfirm: () => saveBypass(true),
                  })
                : saveBypass(false)
            }
          />
        </div>
        {!bypass && (
          <div className="flex flex-col gap-2 border-t border-hairline px-1 pt-3 pb-1">
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
                        ? "bg-accent/10 shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-accent)_55%,transparent)]"
                        : "bg-surface shadow-[0_0_0_1px_var(--color-hairline)] enabled:hover:bg-hover"
                    }`}
                  >
                    <span className="flex items-center justify-between">
                      <Icon className={`size-4 ${on ? "text-accent" : off ? "text-placeholder" : "text-icon"}`} />
                      <span
                        className={`grid size-4 place-items-center rounded-full transition-colors ${
                          on ? "bg-accent text-inverse" : "ring-1 ring-border-strong group-disabled:opacity-0"
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
      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </section>
  );
}
