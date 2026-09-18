import { PROVIDERS } from "@crew/fixtures";
import { ProviderMark, Select, type SelectOption } from "@/ui";

export type ModelValue = `${string}/${string}`;

export const packModel = (provider: string, model: string): ModelValue =>
  `${provider}/${model}` as ModelValue;

export function unpackModel(value: string): { provider: string; model: string } {
  const at = value.indexOf("/");
  return { provider: value.slice(0, at), model: value.slice(at + 1) };
}

const OPTIONS: Array<SelectOption<ModelValue>> = PROVIDERS.flatMap((provider) =>
  provider.models.map((model) => ({
    id: packModel(provider.id, model.id),
    label: model.label,
    ...(model.note ? { note: model.note } : {}),
    group: provider.label,
  })),
);

/**
 * One picker, two shapes: a full-width field in the agent sheet, a chip in the
 * composer. Both show the provider mark beside the model label.
 */
export function ModelPicker({
  provider,
  model,
  onChange,
  shape = "field",
  className,
}: {
  provider: string;
  model: string;
  onChange: (next: { provider: string; model: string }) => void;
  shape?: "field" | "chip";
  className?: string;
}) {
  return (
    <Select
      value={packModel(provider, model)}
      options={OPTIONS}
      onChange={(next) => onChange(unpackModel(next))}
      label="Model"
      shape={shape}
      lead={<ProviderMark provider={provider} />}
      {...(className ? { className } : {})}
    />
  );
}
