import { Popover as Base } from "@base-ui/react/popover";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { isNativeButton, POPUP_SURFACE } from "./Menu";

export type PopoverProps = {
  trigger?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  width?: number | string;
};

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  className,
  width,
}: PopoverProps) {
  return (
    <Base.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange: (next: boolean) => onOpenChange(next) } : {})}
    >
      {trigger ? (
        <Base.Trigger nativeButton={isNativeButton(trigger)} render={trigger as never} />
      ) : null}
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
          <Base.Popup
            className={cx(POPUP_SURFACE, "p-0", className)}
            style={width ? { width } : undefined}
          >
            {children}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

export const PopoverPrimitive = Base;
