import type { ReactNode } from "react";

/** A titled card of rows; the card carries the inset so hairlines stop short of its edge. */
export function SettingsSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title && <h2 className="px-2.5 text-kumo-subtle">{title}</h2>}
      <div className="rounded-xl bg-card px-4">{children}</div>
    </section>
  );
}

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
    <div className="flex min-h-10 items-center gap-6 border-t border-hairline py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="truncate">{label}</p>
        {description && <p className="text-kumo-subtle">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
