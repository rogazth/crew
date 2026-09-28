import type { ReactNode } from "react";
import { Card } from "./kit";

/** A titled card of rows; the card carries the inset so hairlines stop short of its edge. */
export function SettingsSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title && <h2 className="px-2.5 text-[12px] font-medium text-text-muted">{title}</h2>}
      <Card>{children}</Card>
    </section>
  );
}

/** Same rhythm as the kit's Toggle, so a switch row and a control row sit flush in one card. */
export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center gap-6 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate">{label}</p>
        {description && <p className="text-[12px] text-text-muted">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
