import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";

export function Empty({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center justify-center gap-2 px-8 py-16 text-center", className)}>
      <span className="mb-1 flex size-9 items-center justify-center rounded-card bg-[var(--fill-quaternary)] text-icon-faint">
        <Icon name={icon} size={18} />
      </span>
      <p className="text-body text-secondary">{title}</p>
      {description && <p className="max-w-80 text-small text-tertiary">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
