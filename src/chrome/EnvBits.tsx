import { LaptopIcon, ServerIcon } from "lucide-react";
import { LOCAL, type EnvLink } from "../lib/client/registry";
import { statusText } from "../lib/envText";

function tone(link: EnvLink | null): string {
  if (!link || link.id === LOCAL) return "text-icon";
  if (link.mismatch || link.status === "offline") return "text-danger";
  if (link.status === "connecting") return "text-warning";
  return "text-icon";
}

/** The machine: a laptop for this Mac, a server for anything on the tailnet. */
export function EnvGlyph({ link, className = "size-4" }: { link: EnvLink | null; className?: string }) {
  const Glyph = !link || link.id === LOCAL ? LaptopIcon : ServerIcon;
  return <Glyph aria-hidden className={`shrink-0 ${tone(link)} ${className}`} />;
}

/** The glyph on a small tile, the way a machine heads its row. */
export function EnvTile({ link }: { link: EnvLink | null }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-canvas ring-1 ring-hairline">
      <EnvGlyph link={link} />
    </span>
  );
}

/** Green when up (amber through a relay), amber and pulsing while connecting, red when down. */
export function ConnectionDot({ link, relay = false, className = "size-2" }: { link: EnvLink; relay?: boolean; className?: string }) {
  const color =
    link.mismatch || link.status === "offline"
      ? "bg-danger"
      : link.status === "connecting"
        ? "animate-pulse bg-warning"
        : relay
          ? "bg-warning"
          : "bg-success";
  return <span aria-hidden className={`inline-block shrink-0 rounded-full ${color} ${className}`} />;
}

export function ConnectionLabel({ link, relay = false, className = "" }: { link: EnvLink; relay?: boolean; className?: string }) {
  const text = statusText(link);
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] text-text-muted tabular-nums ${className}`}>
      <ConnectionDot link={link} relay={relay} />
      {relay && link.status === "online" ? `Relay · ${text}` : text}
    </span>
  );
}
