import { Switch as Base } from "@base-ui/react/switch";
import { cx } from "@/lib/cx";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  id,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <Base.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next: boolean) => onCheckedChange(next)}
      className={cx(
        "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full p-[2px]",
        "bg-[var(--fill-primary)] transition-colors duration-[var(--dur-2)]",
        "data-[checked]:bg-[var(--accent)] disabled:opacity-40",
        className,
      )}
    >
      <Base.Thumb
        className={cx(
          "size-[14px] rounded-full bg-[var(--surface-canvas)]",
          "shadow-[0_1px_2px_color-mix(in_oklch,var(--ink)_22%,transparent)]",
          "transition-transform duration-[var(--dur-2)] [transition-timing-function:var(--ease-enter)]",
          "data-[checked]:translate-x-[12px]",
        )}
      />
    </Base.Root>
  );
}
