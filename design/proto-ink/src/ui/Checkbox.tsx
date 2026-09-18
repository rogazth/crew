import { Checkbox as Base } from "@base-ui/react/checkbox";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";

export function Checkbox({
  checked,
  onCheckedChange,
  className,
  id,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  className?: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <Base.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next: boolean) => onCheckedChange(next)}
      className={cx(
        "flex size-4 shrink-0 items-center justify-center rounded-xs bg-canvas",
        "hairline transition-colors duration-[var(--dur-2)]",
        "data-[checked]:bg-[var(--accent)] data-[checked]:shadow-none",
        "disabled:opacity-40",
        className,
      )}
    >
      <Base.Indicator className="flex text-[var(--accent-contrast)]">
        <Icon name="check" size={12} strokeWidth={2.25} />
      </Base.Indicator>
    </Base.Root>
  );
}

export function RadioGroup({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (next: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseRadioGroup
      value={value}
      onValueChange={(next: unknown) => onValueChange(String(next))}
      className={className}
    >
      {children}
    </BaseRadioGroup>
  );
}

export function Radio({ value, className }: { value: string; className?: string }) {
  return (
    <BaseRadio.Root
      value={value}
      className={cx(
        "flex size-4 shrink-0 items-center justify-center rounded-full bg-canvas",
        "hairline transition-colors duration-[var(--dur-2)]",
        "data-[checked]:bg-[var(--accent)] data-[checked]:shadow-none",
        className,
      )}
    >
      <BaseRadio.Indicator className="size-1.5 rounded-full bg-[var(--accent-contrast)]" />
    </BaseRadio.Root>
  );
}
