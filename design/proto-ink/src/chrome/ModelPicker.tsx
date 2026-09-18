import { useMemo } from "react";
import { PROVIDERS, modelLabel, providerOf } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { ProviderMark, Select } from "@/ui";
import type { SelectOption } from "@/ui";

export type ModelValue = { provider: string; model: string };

const encode = (provider: string, model: string) => `${provider}::${model}`;
const decode = (value: string): ModelValue => {
  const [provider = "claude", model = ""] = value.split("::");
  return { provider, model };
};

function useOptions(): SelectOption[] {
  return useMemo(
    () =>
      PROVIDERS.flatMap((provider) =>
        provider.models.map((model) => ({
          value: encode(provider.id, model.id),
          label: model.label,
          group: provider.label,
          ...(model.note ? { note: model.note } : {}),
        })),
      ),
    [],
  );
}

/** The full-width field shape, used in the agent sheet. */
export function ModelField({
  value,
  onChange,
  className,
}: {
  value: ModelValue;
  onChange: (next: ModelValue) => void;
  className?: string;
}) {
  const options = useOptions();
  return (
    <Select
      className={cx("w-full", className)}
      size="lg"
      value={encode(value.provider, value.model)}
      onValueChange={(next) => onChange(decode(next))}
      options={options}
      renderValue={() => (
        <span className="flex items-center gap-2">
          <ProviderMark provider={value.provider} size={16} />
          <span className="truncate text-primary">{modelLabel(value.provider, value.model)}</span>
          <span className="truncate text-tertiary">{providerOf(value.provider)?.label}</span>
        </span>
      )}
    />
  );
}

/** The compact chip shape, used in the composer. */
export function ModelChip({
  value,
  onChange,
  className,
}: {
  value: ModelValue;
  onChange: (next: ModelValue) => void;
  className?: string;
}) {
  const options = useOptions();
  return (
    <Select
      className={cx(
        "h-6 gap-1 rounded-full bg-transparent px-1.5 shadow-none hover:bg-[var(--fill-tertiary)]",
        "data-[popup-open]:bg-[var(--fill-tertiary)] data-[popup-open]:shadow-none",
        className,
      )}
      size="sm"
      value={encode(value.provider, value.model)}
      onValueChange={(next) => onChange(decode(next))}
      options={options}
      renderValue={() => (
        <span className="flex items-center gap-1.5">
          <ProviderMark provider={value.provider} size={14} />
          <span className="truncate text-secondary">{modelLabel(value.provider, value.model)}</span>
        </span>
      )}
    />
  );
}

export function ProviderLine({ provider, model }: { provider: string; model: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-micro text-tertiary">
      <Icon name="cpu" size={12} className="shrink-0 opacity-70" />
      <span className="truncate">
        {providerOf(provider)?.label} {modelLabel(provider, model)}
      </span>
    </span>
  );
}
