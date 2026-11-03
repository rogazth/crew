// The connectors page's sections and the tile they share: Crew's connectors
// as the page's one grid of tiles, problems first. With no connector yet,
// Installed is a card round the first-open orbit, above the servers the CLIs
// already have (clis.tsx).
import { ChevronDownIcon, LoaderCircleIcon, LockIcon } from "lucide-react";
import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../../../chrome/kit";
import { ACCOUNT_PROBLEM, ACCOUNT_TONE, TONE_BG, TONE_SOFT, TONE_TEXT, accountsLine, openConnector, ui, useUi, type Tone } from "./lib";
import { brandOf, brandOfServer, type Brand } from "./brand";
import { ServiceMark } from "./mark";
import { useRegistry } from "./registry";
import { conflictsOf, useCopies, useWatchMachines } from "./copies";
import { listJoin, providerName } from "./servers";
import { flowLine, refusalOf, useIntegrations, type Account } from "./store";
import { machineName, useVault } from "./vault";
import { LOCAL } from "../../../lib/client/route";

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
  marks: (Brand | undefined)[];
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
              <ServiceMark brand={mark} size={marks.length > 1 ? (row ? 22 : size - 8) : size} />
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

/** The card speaks for its worst account: what needs you, then what never finished. */
const RANK: Account["state"][] = ["expired", "needs-scope", "failed", "pending", "connected"];

/** Crew's connectors as tiles, each with its status, problems first; the fix is on its page. */
export function Installed() {
  const s = useIntegrations();
  const u = useUi();
  useWatchMachines();
  const { copies } = useCopies();
  const shown = s.connectors.filter((c) => !u.hidden.includes(c.id));
  const worstOf = (accounts: Account[]) => RANK.find((state) => accounts.some((a) => a.state === state)) ?? "connected";
  // A conflict ranks with the problems, after an account that needs the person.
  const rankOf = (c: (typeof shown)[number]) => {
    const at = RANK.indexOf(worstOf(c.accounts));
    return at === RANK.indexOf("connected") && conflictsOf(c, copies).length > 0 ? at - 0.5 : at;
  };
  const connectors = [...shown].sort((a, b) => rankOf(a) - rankOf(b));
  if (s.loaded && s.connectors.length === 0) {
    if (!s.error)
      return (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="Installed" />
          <Empty />
        </section>
      );
    return (
      <section className="flex flex-col gap-2.5">
        <SectionTitle title="Installed" />
        <p className="px-1 text-[12.5px] text-danger">Couldn’t read the connectors: {s.error}</p>
      </section>
    );
  }
  if (connectors.length === 0) return null;
  return (
    <TileSection title="Installed" count={connectors.length} action={<VaultLine />}>
      {connectors.map((connector) => {
        const mine = connector.accounts;
        const running = s.flows.find((f) => f.connectorId === connector.id && f.stage !== "done" && f.stage !== "failed");
        const busy = !!running;
        const worst = mine.length === 0 ? "pending" : worstOf(mine);
        const bad = mine.filter((a) => a.state === worst);
        const word = ACCOUNT_PROBLEM[worst];
        // With several accounts, say which one: "Work · Needs authentication".
        const account = word && (mine.length > 1 && bad.length < mine.length ? `${bad.map((a) => a.label).join(", ")} · ${word}` : word);
        // Its page lists the copies that clash, and the fix for each.
        const clashing = [...new Set(conflictsOf(connector, copies).map((c) => providerName(c.provider)))];
        const conflict = clashing.length > 0 ? `Conflict · also in ${listJoin(clashing)}` : undefined;
        const problem = account ?? conflict;
        return (
          <Tile
            key={connector.id}
            marks={[brandOf(connector)]}
            tone={busy ? "info" : !account && conflict ? "warning" : ACCOUNT_TONE[worst]}
            title={connector.name}
            subtitle={busy ? flowLine(running) : (problem ?? accountsLine(mine))}
            subtitleTone={busy ? "info" : undefined}
            glow={connector.id === u.landed}
            onOpen={() => openConnector(connector.id)}
          />
        );
      })}
    </TileSection>
  );
}

/**
 * Where the sign-ins are kept: one quiet line at the end of Installed's
 * title, which opens the machines and the vault among them.
 */
function VaultLine() {
  const { vaultEnv } = useVault();
  const where = vaultEnv === LOCAL ? "this Mac" : machineName(vaultEnv);
  return (
    <button
      type="button"
      title="Where the sign-ins are kept"
      onClick={() => ui.open({ kind: "vault" })}
      className="-mr-1 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] font-medium text-text-muted outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <LockIcon className="size-3.5" />
      Stored on {where}
    </button>
  );
}

/** No connector yet: the orbit, what a connector is for, and the way to the registry. */
function Empty() {
  return (
    <div className="flex items-center gap-6">
      <MiniOrbit />
      <div className="flex min-w-0 flex-col items-start gap-1">
        <p className="text-[14px] font-medium">No connectors installed</p>
        <p className="max-w-[440px] text-text-muted">Sign in once, use from every CLI.</p>
        <Button variant="primary" className="mt-2.5" onClick={() => ui.go("directory")}>
          Browse connectors
        </Button>
      </div>
    </div>
  );
}

/* ── The small orbit ────────────────────────────────────────────────── */

const SIZE = 144;
const C = SIZE / 2;
const R = 54;
const MARK = 24;

/** How many of the featured connectors the orbit carries. */
const ORBITING = 8;

/** A few of the registry's featured connectors, picked at random each open, turning slowly round an empty centre. */
function MiniOrbit() {
  const { servers } = useRegistry("", 60);
  const found = useMemo(() => shuffle(servers.filter((server) => !refusalOf(server.name))).slice(0, ORBITING).map(brandOfServer), [servers]);
  return (
    <div aria-hidden className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0">
        <circle cx={C} cy={C} r={R} fill="none" strokeWidth="1" strokeDasharray="2 5" className="stroke-border-strong" />
      </svg>
      <div className="absolute inset-0 motion-safe:animate-[c-orbit_120s_linear_infinite]">
        {found.map((brand, i) => {
          const angle = -Math.PI / 2 + (i / found.length) * Math.PI * 2;
          const style: CSSProperties = { left: C + R * Math.cos(angle) - MARK / 2, top: C + R * Math.sin(angle) - MARK / 2 };
          return (
            <div key={brand.id} className="absolute" style={{ ...style, width: MARK, height: MARK }}>
              <div className="size-full motion-safe:animate-[c-unorbit_120s_linear_infinite]">
                <ServiceMark brand={brand} size={MARK} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A copy in random order (Fisher–Yates). */
function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
