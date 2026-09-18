import { Checkbox } from "@base-ui/react/checkbox";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Switch } from "@base-ui/react/switch";
import { cx } from "@/lib/cx";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className={cx(
        // Base UI renders the root as a <span>; without a display it stays
        // inline and the width and height do nothing.
        "rise-1 relative block h-[22px] w-[38px] shrink-0 rounded-full p-[3px] transition-colors duration-[120ms]",
        "data-[unchecked]:bg-sunken data-[unchecked]:shadow-[inset_0_1px_2px_rgb(var(--shadow-ink)/0.08),0_0_0_1px_var(--line)]",
        "data-[checked]:bg-accent data-[checked]:shadow-[var(--e1)]",
        "disabled:opacity-45",
      )}
    >
      <Switch.Thumb
        className={cx(
          "block size-4 rounded-full bg-raised el-1 transition-transform duration-[160ms]",
          "data-[checked]:translate-x-4",
        )}
      />
    </Switch.Root>
  );
}

export function Check({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  className?: string;
}) {
  return (
    <Checkbox.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className={cx(
        "rise-1 grid size-[18px] shrink-0 place-items-center rounded-[6px]",
        "data-[unchecked]:bg-base data-[unchecked]:shadow-[inset_0_1px_2px_rgb(var(--shadow-ink)/0.06),0_0_0_1.5px_var(--line-strong)]",
        "data-[checked]:bg-accent data-[checked]:text-on-accent data-[checked]:el-1",
        className,
      )}
    >
      <Checkbox.Indicator className="flex">
        <Icon name="check" size={13} />
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

export function RadioPick({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string; description?: string; keycap?: string }>;
  className?: string;
}) {
  return (
    <RadioGroup value={value} onValueChange={(next) => onChange(String(next))} className={cx("flex flex-col gap-1.5", className)}>
      {options.map((option) => (
        <label
          key={option.value}
          className="rise-1 flex cursor-pointer items-start gap-2.5 rounded-control bg-raised px-3 py-2.5 el-1 hover:bg-raised-2"
        >
          <Radio.Root
            value={option.value}
            className={cx(
              "mt-[2px] grid size-[18px] shrink-0 place-items-center rounded-full",
              "data-[unchecked]:bg-base data-[unchecked]:shadow-[inset_0_1px_2px_rgb(var(--shadow-ink)/0.06),0_0_0_1.5px_var(--line-strong)]",
              "data-[checked]:bg-accent data-[checked]:el-1",
            )}
          >
            <Radio.Indicator className="size-1.5 rounded-full bg-[var(--ink-on-accent)]" />
          </Radio.Root>
          <span className="min-w-0 flex-1">
            <span className="block text-base text-ink">{option.label}</span>
            {option.description && <span className="mt-0.5 block text-sm text-ink-52">{option.description}</span>}
          </span>
          {option.keycap && <Kbd className="mt-[1px]">{option.keycap}</Kbd>}
        </label>
      ))}
    </RadioGroup>
  );
}
