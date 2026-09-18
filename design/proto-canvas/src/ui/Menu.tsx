import type { ReactElement, ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { ContextMenu } from "@base-ui/react/context-menu";
import { cx } from "@/lib/cx";
import { Icon, type GlyphName } from "./Icon";
import { Kbd } from "./Kbd";

const POPUP =
  "enter-pop min-w-[200px] max-h-[70vh] overflow-auto scroller rounded-card bg-overlay p-1.5 el-3 outline-none";

const ITEM =
  "flex h-8 w-full cursor-default select-none items-center gap-2.5 rounded-[8px] px-2.5 text-base text-ink " +
  "outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-ink data-[disabled]:opacity-40";

export type MenuSide = "top" | "bottom" | "left" | "right";
export type MenuAlign = "start" | "center" | "end";

export function MenuRoot({
  trigger,
  children,
  side = "bottom",
  align = "start",
  open,
  onOpenChange,
}: {
  trigger: ReactElement;
  children: ReactNode;
  side?: MenuSide;
  align?: MenuAlign;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner side={side} align={align} sideOffset={6} className="z-[60]">
          <Menu.Popup className={POPUP}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function MenuItem({
  children,
  onClick,
  icon,
  keys,
  danger,
  disabled,
  closeOnClick = true,
}: {
  children: ReactNode;
  onClick?: () => void;
  icon?: GlyphName;
  keys?: string;
  danger?: boolean;
  disabled?: boolean;
  closeOnClick?: boolean;
}) {
  return (
    <Menu.Item
      onClick={onClick}
      disabled={disabled}
      closeOnClick={closeOnClick}
      className={cx(ITEM, danger && "text-[var(--danger)] data-[highlighted]:bg-danger-soft")}
    >
      {icon && <Icon name={icon} size={15} className="shrink-0 opacity-70" />}
      <span className="flex-1 truncate text-left">{children}</span>
      {keys && <Kbd>{keys}</Kbd>}
    </Menu.Item>
  );
}

export function MenuCheckItem({
  children,
  checked,
  onChange,
  closeOnClick = false,
}: {
  children: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  closeOnClick?: boolean;
}) {
  return (
    <Menu.CheckboxItem checked={checked} onCheckedChange={onChange} closeOnClick={closeOnClick} className={ITEM}>
      <span className="grid size-4 shrink-0 place-items-center">
        <Menu.CheckboxItemIndicator className="flex text-accent-text">
          <Icon name="check" size={14} />
        </Menu.CheckboxItemIndicator>
      </span>
      <span className="flex-1 truncate text-left">{children}</span>
    </Menu.CheckboxItem>
  );
}

export function MenuRadioGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
      {options.map((option) => (
        <Menu.RadioItem key={option.value} value={option.value} closeOnClick={false} className={ITEM}>
          <span className="grid size-4 shrink-0 place-items-center">
            <Menu.RadioItemIndicator className="flex text-accent-text">
              <Icon name="check" size={14} />
            </Menu.RadioItemIndicator>
          </span>
          <span className="flex-1 truncate text-left">{option.label}</span>
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-38">
      {children}
    </div>
  );
}

export function MenuSep() {
  return <div className="my-1.5 h-px bg-[var(--line-soft)]" />;
}

// --- right-click ------------------------------------------------------------

export function ContextMenuRoot({ trigger, children }: { trigger: ReactElement; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={trigger} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-[60]">
          <ContextMenu.Popup className={POPUP}>{children}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function ContextItem({
  children,
  onClick,
  icon,
  danger,
  keys,
}: {
  children: ReactNode;
  onClick?: () => void;
  icon?: GlyphName;
  danger?: boolean;
  keys?: string;
}) {
  return (
    <ContextMenu.Item
      onClick={onClick}
      className={cx(ITEM, danger && "text-[var(--danger)] data-[highlighted]:bg-danger-soft")}
    >
      {icon && <Icon name={icon} size={15} className="shrink-0 opacity-70" />}
      <span className="flex-1 truncate text-left">{children}</span>
      {keys && <Kbd>{keys}</Kbd>}
    </ContextMenu.Item>
  );
}

export function ContextSep() {
  return <div className="my-1.5 h-px bg-[var(--line-soft)]" />;
}
