import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";

export function TooltipHost({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delay={420} closeDelay={80}>
      {children}
    </Tooltip.Provider>
  );
}

export function Tip({
  content,
  children,
  side = "bottom",
}: {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={8} className="z-[70]">
          <Tooltip.Popup className="enter-pop max-w-[280px] rounded-chip bg-overlay px-2.5 py-1.5 text-sm text-ink el-3">
            {content}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
