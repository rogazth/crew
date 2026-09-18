import type { ReactNode } from "react";
import { Icon, type GlyphName } from "./Icon";

export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon: GlyphName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-card bg-raised text-ink-38 el-1">
        <Icon name={icon} size={22} />
      </span>
      <div>
        <p className="text-md font-medium text-ink">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-[42ch] text-base text-ink-52">{description}</p>}
      </div>
      {action}
    </div>
  );
}
