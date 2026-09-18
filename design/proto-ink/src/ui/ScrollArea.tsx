import { forwardRef, type HTMLAttributes } from "react";
import { cx } from "@/lib/cx";

export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className, children, ...rest }, ref) {
    return (
      <div ref={ref} className={cx("ink-scroll min-h-0 overflow-y-auto", className)} {...rest}>
        {children}
      </div>
    );
  },
);
