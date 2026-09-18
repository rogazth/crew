import { Menu as Base } from "@base-ui/react/menu";
import { ContextMenu as BaseContext } from "@base-ui/react/context-menu";
import { isValidElement, type ComponentProps, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";

export const POPUP_SURFACE =
  "ink-pop e2 rounded-card bg-canvas p-1 text-body text-primary outline-none";

const ITEM =
  "relative flex h-7 cursor-default select-none items-center gap-2 rounded-md px-2 text-body " +
  "text-secondary outline-none transition-colors duration-[var(--dur-1)] " +
  "data-[highlighted]:bg-[var(--fill-tertiary)] data-[highlighted]:text-primary " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40";

const DESTRUCTIVE =
  "text-[var(--status-danger)] data-[highlighted]:bg-[var(--danger-fill)] data-[highlighted]:text-[var(--status-danger)]";

export type MenuItemProps = ComponentProps<typeof Base.Item> & {
  icon?: IconName;
  hint?: ReactNode;
  destructive?: boolean;
};

export function MenuItem({ icon, hint, destructive, className, children, ...rest }: MenuItemProps) {
  return (
    <Base.Item className={cx(ITEM, destructive && DESTRUCTIVE, className)} {...rest}>
      {icon && <Icon name={icon} size={14} className="shrink-0 opacity-75" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 pl-3 text-micro text-quaternary tnum">{hint}</span>}
    </Base.Item>
  );
}

export function MenuCheckItem({
  icon,
  hint,
  className,
  children,
  ...rest
}: ComponentProps<typeof Base.CheckboxItem> & { icon?: IconName; hint?: ReactNode }) {
  return (
    <Base.CheckboxItem className={cx(ITEM, "pl-1.5", className)} {...rest}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Base.CheckboxItemIndicator>
          <Icon name="check" size={14} className="text-[var(--accent)]" />
        </Base.CheckboxItemIndicator>
      </span>
      {icon && <Icon name={icon} size={14} className="shrink-0 opacity-75" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 pl-3 text-micro text-quaternary">{hint}</span>}
    </Base.CheckboxItem>
  );
}

export function MenuRadioItem({
  className,
  children,
  ...rest
}: ComponentProps<typeof Base.RadioItem>) {
  return (
    <Base.RadioItem className={cx(ITEM, "pl-1.5", className)} {...rest}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Base.RadioItemIndicator>
          <Icon name="check" size={14} className="text-[var(--accent)]" />
        </Base.RadioItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Base.RadioItem>
  );
}

export function MenuLabel({ className, children, ...rest }: ComponentProps<typeof Base.GroupLabel>) {
  return (
    <Base.GroupLabel
      className={cx("px-2 pb-1 pt-1.5 text-micro font-[var(--weight-medium)] uppercase tracking-[0.06em] text-quaternary", className)}
      {...rest}
    >
      {children}
    </Base.GroupLabel>
  );
}

export function MenuSeparator({ className, ...rest }: ComponentProps<typeof Base.Separator>) {
  return <Base.Separator className={cx("mx-1 my-1 h-px bg-[var(--stroke-tertiary)]", className)} {...rest} />;
}

export type MenuProps = {
  trigger: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  width?: number | string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/**
 * Base UI's trigger renders a `<button>` and, when handed something else,
 * warns that the element loses a button's keyboard and form behaviour. Several
 * of these triggers are deliberately a `<span>` — a sidebar row, an icon slot
 * inside a row that is itself clickable — so the flag follows what was actually
 * handed over rather than asserting a button that is not there.
 */
export function isNativeButton(node: ReactNode): boolean {
  return isValidElement(node) && node.type === "button";
}

export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  width,
  open,
  onOpenChange,
  className,
}: MenuProps) {
  return (
    <Base.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange: (next: boolean) => onOpenChange(next) } : {})}
    >
      <Base.Trigger nativeButton={isNativeButton(trigger)} render={trigger as never} />
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
          <Base.Popup
            className={cx(POPUP_SURFACE, "min-w-44", className)}
            style={width ? { width } : undefined}
          >
            {children}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

export function ContextMenu({
  trigger,
  children,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseContext.Root>
      <BaseContext.Trigger render={trigger as never} />
      <BaseContext.Portal>
        <BaseContext.Positioner className="z-50">
          <BaseContext.Popup className={cx(POPUP_SURFACE, "min-w-48", className)}>
            {children}
          </BaseContext.Popup>
        </BaseContext.Positioner>
      </BaseContext.Portal>
    </BaseContext.Root>
  );
}

export const MenuPrimitive = Base;
