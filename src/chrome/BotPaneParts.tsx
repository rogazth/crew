// A bot's settings' pieces (BotDialog.tsx), drawn the way Connectors draws a connector's page:
// cards of rows on the sheet, hairlines between them, an icon, a title over a
// muted line, and the row's control at its right end. No eyebrow over a card:
// what a card holds says what it is, in its own first row when it needs one.
import type { ReactNode } from "react";

/** A card of rows, hairlines between them. */
// A rule between rows, never on the focus guards a picker puts beside its trigger while its menu is open.
const BETWEEN_ROWS = "[&>:not([data-base-ui-focus-guard])~:not([data-base-ui-focus-guard])]:border-t [&>:not([data-base-ui-focus-guard])~:not([data-base-ui-focus-guard])]:border-hairline";

export function PaneCard({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section aria-label={label} className={`rounded-xl bg-card px-4 ${BETWEEN_ROWS}`}>
      {children}
    </section>
  );
}

/** A card's first row when it holds a list: what the list is, how many, and anything to say at the right. */
export function CardHead({ title, aside, bare = false }: { title: string; aside?: ReactNode; /** No rule between it and the first row. */ bare?: boolean }) {
  return (
    <header className={`flex items-center gap-2 py-2.5 ${bare ? "min-h-9 pb-1.5 [&+*]:border-t-0!" : "min-h-11"}`}>
      <h3 className="text-[13px] font-medium">{title}</h3>
      <span className="ml-auto text-[12px] text-text-muted tabular-nums">{aside}</span>
    </header>
  );
}

/**
 * A row: icon, title over a muted line, and its control at the right end.
 * `toggles`: the whole row is the control's label, so a press anywhere on it
 * flips the switch it holds.
 */
export function PaneRow({
  icon,
  title,
  line,
  toggles = false,
  onClick,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  line?: ReactNode;
  toggles?: boolean;
  /** The whole row is a button, opening what it stands for. */
  onClick?: () => void;
  children?: ReactNode;
}) {
  const Root = toggles ? "label" : onClick ? "button" : "div";
  return (
    <Root
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={`flex min-h-12 w-full items-center gap-3 py-2.5 text-left ${toggles ? "cursor-pointer select-none" : ""} ${
        onClick ? "group outline-none focus-visible:[&_[data-row-go]]:text-text" : ""
      }`}
    >
      {/* On the title's line: up top beside two lines, centred beside one. */}
      {icon && <span className={`grid w-5 shrink-0 place-items-center text-icon ${line ? "h-[18px] self-start" : "h-5"}`}>{icon}</span>}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] leading-[18px] font-medium">{title}</span>
        {line && <span className="text-[12px] leading-4 text-text-muted">{line}</span>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </Root>
  );
}

/**
 * A row read as a sentence, Shortcuts-style: icon and title, and under the
 * title the sentence itself, each tinted word (TOKEN) a control opening only
 * what it says.
 */
export function PaneSentence({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-start gap-3 py-2.5">
      <span className="grid h-[18px] w-5 shrink-0 place-items-center text-icon">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] leading-[18px] font-medium">{title}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[13px] leading-5">{children}</div>
      </div>
    </div>
  );
}

/** The row that adds one more to a card's list. */
export function AddRow({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-12 w-full items-center gap-3 pb-0.5 text-left text-[13px] text-text-muted outline-none transition-colors hover:text-text focus-visible:text-text"
    >
      {children}
    </button>
  );
}
