import { Tooltip as Base } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Base.Provider delay={420} closeDelay={80}>
      {children}
    </Base.Provider>
  );
}

export type TooltipProps = {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
};

export function Tooltip({
  content,
  children,
  side = "bottom",
  align = "center",
  sideOffset = 6,
  className,
}: TooltipProps) {
  if (content === null || content === undefined || content === "") return <>{children}</>;
  return (
    <Base.Root>
      <Base.Trigger render={children as never} />
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={sideOffset} className="z-[60]">
          <Base.Popup
            className={cx(
              "ink-pop e2 max-w-72 rounded-md bg-canvas px-2 py-1 text-micro leading-[16px] text-secondary",
              className,
            )}
          >
            {content}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
