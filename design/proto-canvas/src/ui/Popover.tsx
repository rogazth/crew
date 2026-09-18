import type { ReactElement, ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { cx } from "@/lib/cx";

export function Pop({
  trigger,
  children,
  side = "bottom",
  align = "start",
  width,
  open,
  onOpenChange,
  className,
}: {
  trigger: ReactElement;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  width?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner side={side} align={align} sideOffset={8} className="z-[60]">
          <Popover.Popup
            style={width ? { width } : undefined}
            className={cx("enter-pop rounded-card bg-overlay el-3 outline-none", className)}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
