// PROTOTYPE — throwaway. Variant C's sections and the tile they share: Crew's
// connectors as the page's one grid of big tiles, problems first. With no connector yet, Installed shows the first-open orbit.
import { LoaderCircleIcon, ChevronDownIcon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../../../chrome/kit";
import { ServiceMark } from "./parts.prototype";
import { MiniOrbit } from "./VariantC.header.prototype";
import { VaultLine } from "./VariantC.vaultspot.prototype";
import { ACCOUNT_TONE, TONE_BG, TONE_SOFT, TONE_TEXT, openConnector, ui, useUi, accountsLine, type Tone } from "./VariantC.lib.prototype";
import { serviceOf, useIntegrations, type Account, type Service } from "./store.prototype";

/* ── The tile ───────────────────────────────────────────────────────── */

export type TileAction = { label: string; run: () => void; busy?: boolean | undefined; busyLabel?: string | undefined; muted?: boolean | undefined };

/**
 * One connector, server or registry entry: its mark with a status dot, two lines, and at most one action.
 * `tile` is a filled card; `row` is a smaller outlined one, for a checklist of things to fix.
 */
export function Tile({
  variant = "tile",
  marks,
  icon,
  dim = false,
  tone,
  title,
  subtitle,
  subtitleTone,
  action,
  trailing,
  onOpen,
  glow = false,
}: {
  variant?: "tile" | "row";
  marks: (Service | undefined)[];
  /** In place of the marks, for what has no service (a CLI's own server). */
  icon?: ReactNode;
  /** Off: the tile stays, quieter. */
  dim?: boolean;
  tone?: Tone | undefined;
  title: ReactNode;
  subtitle: ReactNode;
  subtitleTone?: Tone | undefined;
  action?: TileAction | undefined;
  /** Controls at the right end, after the action: a switch, a remove button. */
  trailing?: ReactNode;
  onOpen?: (() => void) | undefined;
  glow?: boolean;
}) {
  const row = variant === "row";
  const size = row ? 24 : 36;
  const open = (event: KeyboardEvent) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onOpen?.();
    }
  };
  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? open : undefined}
      className={`group relative flex min-w-0 items-center outline-none ${
        row ? "h-14 gap-3 rounded-xl pr-1.5 pl-3 ring-1 ring-hairline ring-inset" : "h-14 gap-2.5 rounded-xl bg-card pr-1.5 pl-2.5"
      } ${onOpen ? "cursor-default transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50" : ""} ${dim ? "[&>span:not(:last-child)]:opacity-55" : ""}`}
    >
      {glow && <span className="pointer-events-none absolute inset-0 rounded-xl bg-success/10 opacity-0 ring-2 ring-success/45 motion-safe:animate-[c-glow_1.9s_var(--ease-out)]" />}
      <span className="relative shrink-0">
        {/* Several marks overlap into the width of one, so the text lines up with the rows around it. */}
        <span className={`flex ${row ? "-space-x-3" : "-space-x-2"}`}>
          {icon}
          {marks.map((mark, i) => (
            <span key={mark?.id ?? i} className={marks.length > 1 ? `rounded-[9px] ring-2 ${row ? "ring-canvas" : "ring-card"}` : ""}>
              <ServiceMark service={mark} size={marks.length > 1 ? (row ? 22 : size - 8) : size} />
            </span>
          ))}
        </span>
        {/* The dot only when something's wrong: all well is the quiet case. */}
        {(tone === "warning" || tone === "danger") && <span className={`absolute rounded-full ring-2 ${row ? "-right-[2px] -bottom-[2px] size-2 ring-canvas" : "-right-[2px] -bottom-[2px] size-2.5 ring-canvas"} ${TONE_BG[tone]}`} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        <span className={`truncate text-[12px] ${subtitleTone ? TONE_TEXT[subtitleTone] : "text-text-muted"}`}>{subtitle}</span>
      </span>
      {action && (
        <button
          type="button"
          disabled={action.busy}
          onClick={(event) => {
            event.stopPropagation();
            action.run();
          }}
          className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 disabled:opacity-70 ${
            action.muted ? "text-text-muted" : "text-info"
          }`}
        >
          {action.busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          {action.busy ? (action.busyLabel ?? action.label) : action.label}
        </button>
      )}
      {trailing && (
        <span className="flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
          {trailing}
        </span>
      )}
    </div>
  );
}

/**
 * A section's title, with its count and whatever sits at the right end.
 * Primary is the page's main thing; secondary is smaller and says in one line what the section is.
 */
export function SectionTitle({
  title,
  count,
  description,
  action,
  level = "primary",
  countTone,
}: {
  title: string;
  count?: number | undefined;
  description?: string | undefined;
  action?: ReactNode;
  level?: "primary" | "secondary" | undefined;
  countTone?: Tone | undefined;
}) {
  return (
    <div className="flex min-h-7 items-end gap-3 px-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className={level === "primary" ? "text-[15px] font-semibold" : "text-[13px] font-medium"}>
          {title}
          {count !== undefined &&
            (countTone ? (
              <span className={`ml-2 inline-grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 align-[1px] text-[11px] font-semibold tabular-nums ${TONE_SOFT[countTone]}`}>{count}</span>
            ) : (
              <span className="ml-1.5 font-normal text-text-muted tabular-nums">{count}</span>
            ))}
        </h2>
        {description && <p className="truncate text-[12.5px] text-text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** A titled grid of tiles, or a list card of rows, folded after `fold` items. */
export function TileSection({
  title,
  count,
  description,
  action,
  level,
  countTone,
  layout = "grid",
  children,
  fold = 6,
  className = "",
}: {
  title: string;
  count?: number | undefined;
  description?: string | undefined;
  action?: ReactNode;
  level?: "primary" | "secondary" | undefined;
  countTone?: Tone | undefined;
  layout?: "grid" | "chips";
  children: ReactNode[];
  fold?: number;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const hidden = children.length - fold;
  const shown = all || hidden <= 0 ? children : children.slice(0, fold);
  return (
    <section className={`flex flex-col gap-2.5 ${className}`}>
      <SectionTitle title={title} count={count} description={description} action={action} level={level} countTone={countTone} />
      {layout === "chips" ? (
        <div className="grid grid-cols-2 gap-1.5 @[620px]:grid-cols-3">{shown}</div>
      ) : (
        <div className="grid grid-cols-1 gap-2 @[620px]:grid-cols-2">{shown}</div>
      )}
      {hidden > 0 && (
        <button type="button" onClick={() => setAll((now) => !now)} className="flex items-center gap-1 self-start px-1 text-[12.5px] text-text-muted hover:text-text">
          {all ? "Show less" : `Show ${hidden} more`}
          <ChevronDownIcon className={`size-3.5 transition-transform duration-300 ${all ? "rotate-180" : ""}`} />
        </button>
      )}
    </section>
  );
}

/* ── Installed ──────────────────────────────────────────────────────── */

/** The card speaks for its worst account: what needs you, then what Crew is waiting on. */
const RANK: Account["state"][] = ["expired", "needs-scope", "vault-offline", "lease-ending", "connected"];
const PROBLEM: Partial<Record<Account["state"], string>> = { expired: "Needs authentication", "needs-scope": "Missing permissions", "lease-ending": "Stops soon", "vault-offline": "Paused" };

/** Crew's connectors as tiles, each with its status, problems first; the fix is on its page. */
export function Installed() {
  const s = useIntegrations();
  const u = useUi();
  const accounts = s.accounts.filter((a) => !u.hidden.includes(a.id));
  const worstOf = (id: string) => RANK.find((state) => accounts.some((a) => a.serviceId === id && a.state === state)) ?? "connected";
  const services = [...new Set(accounts.map((a) => a.serviceId))]
    .map(serviceOf)
    .filter((x): x is Service => !!x)
    .sort((a, b) => RANK.indexOf(worstOf(a.id)) - RANK.indexOf(worstOf(b.id)));
  if (s.accounts.length === 0) {
    return (
      <section className="flex flex-col gap-2.5">
        <SectionTitle title="Installed" />
        <Empty />
      </section>
    );
  }
  if (services.length === 0) return null;
  return (
    <TileSection title="Installed" count={services.length} action={<VaultLine />}>
      {services.map((service) => {
        const mine = accounts.filter((a) => a.serviceId === service.id);
        const busy = s.flows.some((f) => f.kind === "account" && f.stage !== "done" && mine.some((a) => a.id === f.target));
        const worst = worstOf(service.id);
        const bad = mine.filter((a) => a.state === worst);
        // With several accounts, say which one: "Work · Needs authentication".
        const problem = PROBLEM[worst] && (mine.length > 1 && bad.length < mine.length ? `${bad.map((a) => a.label).join(", ")} · ${PROBLEM[worst]}` : PROBLEM[worst]);
        return (
          <Tile
            key={service.id}
            marks={[service]}
            tone={busy ? "info" : ACCOUNT_TONE[worst]}
            title={service.name}
            subtitle={busy ? "Authenticating…" : (problem ?? accountsLine(mine))}
            subtitleTone={busy ? "info" : undefined}
            glow={mine.some((a) => a.id === u.landed || s.fresh.includes(a.id))}
            onOpen={() => openConnector(service.id)}
          />
        );
      })}
    </TileSection>
  );
}

function Empty() {
  return (
    <div className="flex items-center gap-6 rounded-xl bg-card py-3 pr-6 pl-4">
      <MiniOrbit />
      <div className="flex min-w-0 flex-col items-start gap-1">
        <p className="text-[14px] font-medium">No connectors installed</p>
        <p className="max-w-[440px] text-text-muted">Sign in once, use from every CLI.</p>
        <Button className="mt-2.5" onClick={() => ui.go("directory")}>
          Browse connectors
        </Button>
      </div>
    </div>
  );
}
