import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Popover } from "./Popover";
import type { Align, AnchorPoint, Side } from "@/lib/hooks";

export type MenuItem =
  | { kind: "separator"; id?: string }
  | { kind: "label"; id: string; label: string }
  | {
      kind?: "item";
      id: string;
      label: string;
      detail?: string;
      kbd?: ReactNode;
      icon?: ReactNode;
      checked?: boolean;
      destructive?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    };

export type MenuProps = {
  open: boolean;
  anchor: HTMLElement | AnchorPoint | null;
  onClose: () => void;
  items: MenuItem[];
  side?: Side;
  align?: Align;
  label?: string;
  width?: number;
  matchWidth?: boolean;
};

const isAction = (item: MenuItem): item is Extract<MenuItem, { onSelect: () => void }> =>
  item.kind !== "separator" && item.kind !== "label";

export function Menu({
  open,
  anchor,
  onClose,
  items,
  side = "bottom",
  align = "start",
  label,
  width,
  matchWidth,
}: MenuProps) {
  const actions = items.filter(isAction).filter((item) => !item.disabled);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setCursor(0);
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (actions.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setCursor((held) => (((held + delta) % actions.length) + actions.length) % actions.length);
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = actions[cursor];
        if (item) {
          onClose();
          item.onSelect();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, actions, cursor, onClose]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-cursor="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  let index = -1;
  return (
    <Popover
      open={open}
      anchor={anchor}
      onClose={onClose}
      side={side}
      align={align}
      role="menu"
      {...(label ? { label } : {})}
      {...(matchWidth ? { matchWidth } : {})}
      className="min-w-[180px] py-1"
    >
      <div ref={listRef} style={width ? { width } : undefined}>
        {items.map((item, at) => {
          if (item.kind === "separator") {
            return <div key={item.id ?? `sep-${at}`} className="my-1 h-px bg-rule" />;
          }
          if (item.kind === "label") {
            return (
              <div
                key={item.id}
                className="px-2 pt-1 pb-0.5 font-mono text-xs tracking-wide text-ink-4 uppercase"
              >
                {item.label}
              </div>
            );
          }
          if (!item.disabled) index += 1;
          const active = !item.disabled && index === cursor;
          return (
            <button
              key={item.id}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              data-cursor={active}
              onMouseEnter={() => !item.disabled && setCursor(index)}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              className={clsx(
                "flex h-[var(--row-h)] w-full items-center gap-2 px-2 text-left text-md",
                "transition-colors duration-[var(--fast)] disabled:opacity-40",
                active && "bg-raised",
                item.destructive ? "text-red-ink" : "text-ink",
              )}
            >
              {item.icon ? (
                <span className="grid size-4 shrink-0 place-items-center text-ink-3">{item.icon}</span>
              ) : item.checked !== undefined ? (
                <span className="grid size-4 shrink-0 place-items-center text-ink-2">
                  {item.checked ? <Check size={13} strokeWidth={1.25} /> : null}
                </span>
              ) : null}
              <span className="truncate">{item.label}</span>
              {item.detail ? (
                <span className="ml-auto shrink-0 font-mono text-xs text-ink-4">{item.detail}</span>
              ) : null}
              {item.kbd ? <span className={clsx(item.detail ? "pl-2" : "ml-auto pl-2")}>{item.kbd}</span> : null}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
