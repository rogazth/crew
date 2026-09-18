import { useMemo } from "react";
import { PROVIDERS, modelLabel } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/ui/Icon";
import { Select, type OptionGroup } from "@/ui/Select";
import { ProviderIcon } from "./ProviderIcon";

export type ModelValue = `${string}:${string}`;

export const modelValue = (provider: string, model: string): ModelValue => `${provider}:${model}`;

export function splitModel(value: string): { provider: string; model: string } {
  const at = value.indexOf(":");
  return { provider: value.slice(0, at), model: value.slice(at + 1) };
}

/**
 * One list, two trigger shapes: a full-width field in the agent sheet and a
 * compact chip in the composer.
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
  onChange: (provider: string, model: string) => void;
  shape?: "field" | "chip";
  className?: string;
}) {
  const groups = useMemo<OptionGroup<string>[]>(
    () =>
      PROVIDERS.map((entry) => ({
        label: entry.label,
        options: entry.models.map((m) => ({
          value: modelValue(entry.id, m.id),
          label: m.label,
          ...(m.note ? { note: m.note } : {}),
          icon: <ProviderIcon provider={entry.id} size={14} className="shrink-0 text-ink-52" />,
        })),
      })),
    [],
  );

  const current = modelValue(provider, model);

  return (
    <Select
      value={current}
      groups={groups}
      onChange={(next) => {
        const parsed = splitModel(next);
        onChange(parsed.provider, parsed.model);
      }}
      className={cx(shape === "field" && "w-full", className)}
      {...(shape === "chip"
        ? {
            trigger: () => (
              <span className="rise-1 inline-flex h-7 items-center gap-1.5 rounded-chip bg-raised px-2 text-sm text-ink-70 el-1 hover:text-ink">
                <ProviderIcon provider={provider} size={13} />
                {modelLabel(provider, model)}
                <Icon name="chevronDown" size={12} className="text-ink-38" />
              </span>
            ),
          }
        : {})}
    />
  );
}
