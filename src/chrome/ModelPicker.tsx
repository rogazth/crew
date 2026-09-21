import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { ProviderIcon } from "./ProviderIcon";
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

/** Provider tabs over a model list. */
export function ModelPicker({ provider, model, trigger = "field", disabled = false, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ProviderId>(provider as ProviderId);
  const chip = trigger === "chip";

  useEffect(() => setTab(provider as ProviderId), [provider, open]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      {chip ? (
        <Popover.Trigger
          disabled={disabled}
          title={`${providerOf(provider)?.label ?? provider} ${modelLabel(provider, model)}`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] leading-4 text-kumo-default outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50 disabled:text-kumo-subtle disabled:hover:bg-transparent data-popup-open:bg-hover"
        >
          <ProviderIcon provider={provider} className="size-3.5" />
          <span className="min-w-0 max-w-[140px] truncate">{modelLabel(provider, model)}</span>
          <CaretDownIcon className="size-3 shrink-0 text-kumo-subtle" />
        </Popover.Trigger>
      ) : (
        <Popover.Trigger className="flex h-9 w-full items-center gap-2 rounded-lg bg-kumo-control px-2.5 text-kumo-default ring ring-kumo-line outline-none transition-[box-shadow] hover:ring-kumo-interact focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50 data-popup-open:ring-[1.5px] data-popup-open:ring-kumo-focus/50">
          <ProviderIcon provider={provider} className="size-4" />
          <span className="min-w-0 flex-1 truncate text-left">
            {providerOf(provider)?.label} {modelLabel(provider, model)}
          </span>
          <CaretDownIcon className="size-3.5 shrink-0 text-kumo-subtle" />
        </Popover.Trigger>
      )}

      <Popover.Portal>
        <Popover.Positioner side={chip ? "top" : "bottom"} align="start" sideOffset={4} className="z-50">
          <Popover.Popup
            className={`${chip ? "w-[280px]" : "w-(--anchor-width)"} origin-(--transform-origin) overflow-hidden rounded-lg bg-kumo-control text-kumo-default shadow-lg ring ring-kumo-line outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0`}
          >
            <div role="tablist" className="flex border-b border-kumo-line">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  title={p.label}
                  aria-selected={p.id === tab}
                  onClick={() => setTab(p.id)}
                  className={`relative flex flex-1 items-center justify-center gap-1.5 py-2.5 transition-colors ${
                    p.id === tab ? "text-kumo-default" : "text-kumo-subtle hover:bg-hover"
                  }`}
                >
                  <ProviderIcon provider={p.id} className="size-4" />
                  <span className="text-[11px]">{p.label}</span>
                  {p.id === tab && (
                    <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-kumo-default" />
                  )}
                </button>
              ))}
            </div>

            <div className="max-h-80 overflow-y-auto p-1">
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
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{m.label}</span>
                      {m.note && (
                        <span className="block truncate text-[11px] text-kumo-subtle">
                          {m.note}
                        </span>
                      )}
                    </span>
                    {current && <CheckIcon className="size-4 shrink-0" />}
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
