// A line above the composer when the session's provider is close to its plan
// limit, so a long turn does not start into a wall.
import { AlertTriangleIcon } from "lucide-react";
import { span, useAlerts, useReadings, warningFor } from "../../lib/usage";

export function UsageWarning({ provider }: { provider: string }) {
  const readings = useReadings();
  const alerts = useAlerts();
  const hit = warningFor(readings, provider, alerts.composer);
  if (!hit) return null;
  const { reading, window } = hit;
  return (
    <div
      role="status"
      className="mb-1.5 flex items-center gap-2 rounded-xl bg-card px-3 py-1.5 text-[12px] text-text-muted"
    >
      <AlertTriangleIcon aria-hidden className={`size-3.5 shrink-0 ${window.used >= 95 ? "text-danger" : "text-warning"}`} />
      <span className="min-w-0 truncate">
        {reading.name} {window.label.toLowerCase()} limit is {window.used}% used
        {window.resetsIn !== null && `, resets in ${span(window.resetsIn)}`}.
      </span>
    </div>
  );
}
