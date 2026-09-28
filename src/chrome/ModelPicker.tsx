import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { ProviderIcon } from "./ProviderIcon";
import { useInstalledProviders } from "../hooks/useInstalledProviders";
import {
  PROVIDERS,
  modelLabel,
  modelsOf,
  providerOf,
  type ProviderId,
} from "../lib/providers";

type Props = {
  provider: string;
  model: string;
  /** "field" is the sheet's full-width control; "chip" is the composer's compact trigger. */
  trigger?: "field" | "chip";
  disabled?: boolean;
  onChange: (provider: ProviderId, model: string) => void;
};

/** Providers beside their models, the way ChatGPT and Grok pick one: hover a provider, click a model. */
export function ModelPicker({ provider, model, trigger = "field", disabled = false, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ProviderId>(provider as ProviderId);
  const chip = trigger === "chip";
  const installed = useInstalledProviders(open);
  // The session's own provider stays reachable even after its CLI is gone.
  const tabs = PROVIDERS.filter((p) => p.id === provider || installed.includes(p));

  function openChange(next: boolean) {
    if (next) setTab(provider as ProviderId);
    setOpen(next);
  }

  return (
    <Popover.Root open={open} onOpenChange={openChange} modal={false}>
      {chip ? (
        <Popover.Trigger
          disabled={disabled}
          title={`${providerOf(provider)?.label ?? provider} ${modelLabel(provider, model)}`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] leading-4 text-text ring-1 ring-hairline outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-focus/50 disabled:text-text-muted disabled:hover:bg-transparent data-popup-open:bg-hover"
        >
          <ProviderIcon provider={provider} className="size-3.5" />
          <span className="min-w-0 max-w-[140px] truncate">{modelLabel(provider, model)}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-icon" />
        </Popover.Trigger>
      ) : (
        <Popover.Trigger className="flex h-8 w-full items-center gap-2 rounded-lg bg-canvas px-2.5 text-text ring ring-border outline-none transition-[box-shadow] hover:ring-border-strong focus-visible:ring-[1.5px] focus-visible:ring-focus/50 data-popup-open:ring-[1.5px] data-popup-open:ring-focus/50">
          <ProviderIcon provider={provider} className="size-4" />
          <span className="min-w-0 flex-1 truncate text-left">
            {providerOf(provider)?.label} {modelLabel(provider, model)}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-icon" />
        </Popover.Trigger>
      )}

      <Popover.Portal>
        <Popover.Positioner side={chip ? "top" : "bottom"} align="start" sideOffset={4} className="z-50">
          <Popover.Popup
            className="flex h-[340px] w-[420px] origin-(--transform-origin) overflow-hidden rounded-float bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
          >
            {/* Who runs it on the left, what it runs on the right: two lists, not tabs over one. */}
            <div role="tablist" aria-orientation="vertical" className="flex w-[136px] shrink-0 flex-col gap-0.5 border-r border-hairline bg-sidebar/60 p-1.5">
              <span className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">Provider</span>
              {tabs.map((p) => {
                const on = p.id === tab;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setTab(p.id)}
                    onMouseEnter={() => setTab(p.id)}
                    className={`flex h-8 items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                      on ? "bg-selected text-text" : "text-text/85 hover:bg-hover"
                    }`}
                  >
                    <ProviderIcon provider={p.id} className="size-4" />
                    <span className="min-w-0 flex-1 truncate">{p.label}</span>
                    {p.id === provider && <span className="size-1.5 shrink-0 rounded-full bg-text" aria-label="In use" />}
                  </button>
                );
              })}
            </div>

            <div role="tabpanel" className="flex min-w-0 flex-1 flex-col overflow-y-auto p-1.5">
              <span className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">{providerOf(tab)?.label} models</span>
              {modelsOf(tab).map((m) => {
                const current = tab === provider && m.id === model;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onChange(tab, m.id);
                      setOpen(false);
                    }}
                    className={`flex min-h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover ${
                      current ? "bg-card" : ""
                    }`}
                  >
                    <span className={`min-w-0 flex-1 truncate ${current ? "font-medium" : ""}`}>{m.label}</span>
                    {m.note && (
                      <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] text-text-muted ring-1 ring-hairline">
                        {m.note}
                      </span>
                    )}
                    {current && <CheckIcon className="size-4 shrink-0 text-icon" />}
                  </button>
                );
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
