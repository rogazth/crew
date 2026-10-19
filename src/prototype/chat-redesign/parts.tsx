/* eslint-disable react-refresh/only-export-components -- PROTOTYPE, throwaway */
// PROTOTYPE — throwaway. Small pieces the variants share: the transcript,
// state dots, the context readouts, the fast toggles and the scenario bar.
// Layout is each variant's own.
import { BotIcon, FileTextIcon, PencilIcon, SearchIcon, LayersIcon, TerminalIcon, UsersIcon, WrenchIcon, ZapIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { LABEL, tokens, type Entry, type EntryKind, type Fast, type Item, type Provider, type Sim } from "./sim";
import chatgpt from "./chatgpt-mark.svg?raw";

/** The provider's mark; Codex shows as ChatGPT, with its mark in the text colour. */
export function Mark({ provider, className = "size-4" }: { provider: string; className?: string }) {
  if (provider === "codex")
    return <span aria-hidden className={`${className} inline-block shrink-0 [&>svg]:size-full`} dangerouslySetInnerHTML={{ __html: chatgpt }} />;
  return <ProviderIcon provider={provider} className={className} />;
}

/** The chat's own tool glyphs (Activity.tsx DETAIL_ICON), picked from what the line says it did. */
function toolIcon(text: string): LucideIcon {
  if (/^(Started a subagent|delegate)/.test(text)) return BotIcon;
  if (/^(Read|Reading)/.test(text)) return FileTextIcon;
  if (/^(Grep|Found|Checking|Search)/.test(text)) return SearchIcon;
  if (/^Edit/.test(text)) return PencilIcon;
  if (/^(Running|Sent to the background|cargo|npm)/.test(text)) return TerminalIcon;
  return WrenchIcon;
}

export const CHIP =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] leading-4 text-text ring-1 ring-hairline outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-focus/50";

export function Thread({ items, working, onOpenEntry }: { items: Item[]; working: boolean; onOpenEntry?: (id: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-6 py-6">
      {items.map((item) => {
        if (item.role === "user")
          return (
            <div key={item.id} className="flex flex-col items-end gap-1">
              <div className="max-w-[80%] rounded-2xl bg-card px-3.5 py-2 text-[14px] leading-[21px] whitespace-pre-wrap">{item.text}</div>
              {item.tag && <span className="text-[11px] text-text-muted">{item.tag}</span>}
            </div>
          );
        if (item.role === "tool")
          return (
            <button
              key={item.id}
              type="button"
              disabled={!item.entryId || !onOpenEntry}
              onClick={() => item.entryId && onOpenEntry?.(item.entryId)}
              className="group flex items-center gap-2 text-left text-[13px] text-text-muted enabled:hover:text-text"
            >
              <span className="crew-node">{(() => { const Glyph = toolIcon(item.text); return <Glyph className="size-3.5" />; })()}</span>
              <span className="truncate">{item.text}</span>
              {item.entryId && onOpenEntry && <span className="text-[11px] text-placeholder group-hover:text-text-muted">open</span>}
            </button>
          );
        if (item.role === "note")
          return (
            <div key={item.id} className="flex items-center gap-2 text-[12px] text-text-muted">
              <span className="h-px flex-1 bg-hairline" />
              {item.text}
              <span className="h-px flex-1 bg-hairline" />
            </div>
          );
        return (
          <p key={item.id} className="text-[14px] leading-[22px]">
            {item.text}
          </p>
        );
      })}
      {working && <span className="crew-bg-dot self-start" aria-label="Working" />}
    </div>
  );
}

export function StateDot({ state }: { state: Entry["state"] }) {
  if (state === "running") return <span className="crew-bg-dot" aria-hidden />;
  const tone = state === "failed" ? "bg-danger" : state === "stopped" ? "bg-placeholder" : "bg-success";
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
}

export function KindIcon({ kind, className = "size-3.5" }: { kind: EntryKind; className?: string }) {
  if (kind === "agent") return <BotIcon className={className} />;
  if (kind === "crew") return <UsersIcon className={className} />;
  if (kind === "process") return <LayersIcon className={className} />;
  return <TerminalIcon className={className} />;
}

export function EntryMark({ entry }: { entry: Entry }) {
  return entry.provider ? (
    <span className="relative grid size-4 shrink-0 place-items-center">
      <Mark provider={entry.provider} className="size-3.5" />
    </span>
  ) : (
    <KindIcon kind={entry.kind} className="size-3.5 shrink-0 text-icon" />
  );
}

export const stateWord = (entry: Entry) =>
  entry.state === "running" ? "running" : entry.state === "done" ? "done" : entry.state === "stopped" ? "stopped" : "failed";

/** used / window as a fraction, and where auto-compact sits on the same scale. */
export function contextShare(sim: Sim) {
  const { used, window, autoCompactAt } = sim.context;
  return { share: Math.min(1, used / window), compactAt: autoCompactAt ? autoCompactAt / window : null };
}

const tone = (_share: number) => "text-text-muted";

export function ContextTitle(sim: Sim) {
  const { used, window, autoCompactAt } = sim.context;
  return `${tokens(used)} of ${tokens(window)} context${autoCompactAt ? ` · compacts at ${tokens(autoCompactAt)}` : ""}${
    sim.compactions ? ` · compacted ${sim.compactions}×` : ""
  }`;
}

/** A ring the size of a chip icon, with the percentage beside it. */
export function ContextRing({ sim, label = true }: { sim: Sim; label?: boolean }) {
  const { share } = contextShare(sim);
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <span title={ContextTitle(sim)} className={`flex items-center gap-1 text-[11.5px] tabular-nums ${tone(share)}`}>
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${share * c} ${c}`}
          strokeLinecap="round"
          className="transition-[stroke-dasharray] duration-500"
        />
      </svg>
      {label && `${Math.round(share * 100)}%`}
    </span>
  );
}

/** The ring, with a card on hover: the window, how full it is, and when it compacts. */
export function ContextHover({ sim }: { sim: Sim }) {
  const { used, window, autoCompactAt } = sim.context;
  const { share } = contextShare(sim);
  return (
    <span className="group relative flex h-6 cursor-default items-center px-1.5">
      <ContextRing sim={sim} />
      <span className="invisible absolute bottom-full left-0 z-30 mb-2 w-64 translate-y-1 rounded-xl bg-surface p-3 opacity-0 shadow-float ring-1 ring-border transition-all duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
        <span className="flex items-baseline justify-between">
          <span className="text-[12px] text-text-muted">Context window</span>
          <span className={`text-[12px] tabular-nums ${tone(share)}`}>{Math.round(share * 100)}%</span>
        </span>
        <span className="mt-1 block text-[15px] font-medium tabular-nums">
          {tokens(used)} <span className="text-[12.5px] font-normal text-text-muted">of {tokens(window)}</span>
        </span>
        <span className="mt-2.5 block">
          <ContextBar sim={sim} />
        </span>
        <span className="mt-2 block text-[11.5px] leading-4 text-text-muted">
          {autoCompactAt ? `Compacts on its own at ${tokens(autoCompactAt)}.` : `${sim.provider} compacts on its own near the end.`}
          {sim.compactions ? ` Compacted ${sim.compactions}× so far.` : ""}
        </span>
      </span>
    </span>
  );
}

/** A hairline bar across the top of the composer, with a tick where it compacts. */
export function ContextBar({ sim }: { sim: Sim }) {
  const { share, compactAt } = contextShare(sim);
  void compactAt;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-hairline">
      <div className="h-full rounded-full bg-text-muted transition-[width] duration-500" style={{ width: `${share * 100}%` }} />
    </div>
  );
}

export const fastHidden = (fast: Fast) => fast.availability === "extra_usage_disabled";

/** Fast as it is today: one chip that toggles. */
export function FastChip({ fast, onToggle }: { fast: Fast; onToggle: () => void }) {
  if (fastHidden(fast)) return null;
  const cooling = fast.availability === "cooldown";
  return (
    <button
      type="button"
      aria-pressed={fast.on}
      onClick={onToggle}
      title={cooling ? "Fast is cooling down after a rate limit; standard until then" : "A faster run of this model"}
      className={`${CHIP} shrink-0 ${fast.on ? "bg-selected" : ""}`}
    >
      <ZapIcon className={`size-3.5 shrink-0 ${fast.on ? "fill-current" : "text-icon"} ${cooling ? "opacity-40" : ""}`} />
      Fast
      {cooling && fast.on && <span className="text-[11px] text-text-muted">· cooling</span>}
    </button>
  );
}

/** Standard | Fast as two halves of one control: what it runs on is always said. */
export function FastSegmented({ fast, onToggle }: { fast: Fast; onToggle: () => void }) {
  if (fastHidden(fast)) return null;
  const cooling = fast.availability === "cooldown";
  const half = (on: boolean) =>
    `flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] transition-colors ${
      fast.on === on ? "bg-surface text-text shadow-sm ring-1 ring-hairline" : "text-text-muted hover:text-text"
    }`;
  return (
    <span className="flex h-7 shrink-0 items-center rounded-full bg-card p-0.5" title={cooling ? "Cooling down after a rate limit" : "Speed"}>
      <button type="button" className={half(false)} onClick={() => fast.on && onToggle()}>
        Standard
      </button>
      <button type="button" className={half(true)} onClick={() => !fast.on && onToggle()}>
        <ZapIcon className={`size-3 ${fast.on ? "fill-current" : ""} ${cooling ? "opacity-40" : ""}`} />
        Fast
      </button>
    </span>
  );
}

/**
 * The model chip carries the bolt: one chip says what runs and how fast.
 * Off, the bolt is a quiet half; on, it reads "Fast" and the chip lights up.
 */
export function ModelFastChip({ model, fast, onToggle, icon }: { model: string; fast: Fast; onToggle: () => void; icon?: string }) {
  const hidden = fastHidden(fast);
  const cooling = fast.availability === "cooldown";
  const on = fast.on && !hidden;
  return (
    <span className={`flex h-7 shrink-0 items-center rounded-full ring-1 transition-colors ${on ? "bg-warning/10 ring-warning/40" : "ring-hairline"}`}>
      <span className="flex h-full items-center gap-1.5 rounded-l-full px-2.5 text-[12px] hover:bg-hover">
        {icon && <ProviderIcon provider={icon} className="size-3.5" />}
        {model}
      </span>
      {!hidden && (
        <button
          type="button"
          aria-pressed={fast.on}
          onClick={onToggle}
          title={cooling ? "Cooling down after a rate limit; standard until then" : fast.on ? "Fast — click for standard" : "Run this model fast"}
          className={`flex h-full items-center gap-1 rounded-r-full border-l px-2 text-[11.5px] transition-colors hover:bg-hover ${
            on ? "border-warning/40 text-warning" : "border-hairline text-icon"
          }`}
        >
          <ZapIcon className={`size-3.5 ${on ? "fill-current" : ""} ${cooling ? "opacity-50" : ""}`} />
          {on && (cooling ? "Cooling" : "Fast")}
        </button>
      )}
    </span>
  );
}

export function ScenarioBar({ sim }: { sim: Sim }) {
  const providers: Provider[] = ["claude", "codex", "opencode", "cursor"];
  return (
    <div className="fixed top-3 right-3 z-50 flex items-center gap-1 rounded-full bg-[#111] px-2 py-1 text-[11.5px] text-white shadow-lg">
      <span className="px-1.5 text-white/50">Scenario</span>
      {providers.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => sim.setProvider(p)}
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${sim.provider === p ? "bg-white/20" : "hover:bg-white/10"}`}
        >
          <Mark provider={p} className="size-3 text-white" />
          {LABEL[p]}
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-white/20" />
      <button type="button" onClick={sim.start} disabled={sim.working} className="rounded-full px-2 py-0.5 hover:bg-white/10 disabled:opacity-40">
        Start turn
      </button>
      <select
        value={sim.fast.availability}
        onChange={(e) => sim.setFastAvailability(e.target.value as Fast["availability"])}
        className="rounded-full bg-white/10 px-2 py-0.5 text-white outline-none"
        title="What Claude's initialize said about fast mode"
      >
        <option value="available">fast: available</option>
        <option value="cooldown">fast: cooldown</option>
        <option value="extra_usage_disabled">fast: extra_usage_disabled</option>
      </select>
    </div>
  );
}

/** The live state, printed, so a variant switch shows what each one is reading. */
export function StateReadout({ sim }: { sim: Sim }) {
  const running = sim.entries.filter((e) => e.state === "running").length;
  return (
    <div className="fixed right-3 bottom-4 z-50 rounded-lg bg-[#111]/90 px-2.5 py-1.5 font-mono text-[10.5px] leading-4 text-white/80 shadow-lg">
      <div>working: {String(sim.working)}{sim.paused ? " (paused after stop)" : ""}</div>
      <div>queue: {sim.queue.map((q) => q.mode).join(", ") || "—"}</div>
      <div>background: {running} running / {sim.entries.length}</div>
      <div>context: {tokens(sim.context.used)} / {tokens(sim.context.window)}</div>
      <div>fast: {sim.fast.on ? "on" : "off"} · {sim.fast.availability}</div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 pt-2 pb-1 text-[11px] text-text-muted">{title}</div>
      {children}
    </div>
  );
}
