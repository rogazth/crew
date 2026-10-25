import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

type Props = {
  /** What the field is for, read out by assistive tech: "Find in terminal". */
  label: string;
  query: string;
  results: { index: number; count: number };
  /** Bumped by the shortcut so a second press re-selects the field. */
  focusToken: number;
  onQuery: (value: string) => void;
  /** -1 is the match above, 1 the one below. */
  onStep: (delta: number) => void;
  onClose: () => void;
  /** Said in place of "3 of 12": "No results", or a count the caller words itself. */
  summary?: { text: string; empty?: boolean; busy?: boolean };
  /** Enter walks up, as in a chat, where what you look for was said before. */
  enterGoesUp?: boolean;
  /** What the arrows are called, when "previous" and "next" would not say which way. */
  stepLabels?: { up: string; down: string };
};

/** The find field that floats over a terminal, a page or a chat. */
export function FindBar({
  label,
  query,
  results,
  focusToken,
  onQuery,
  onStep,
  onClose,
  summary,
  enterGoesUp = false,
  stepLabels = { up: "Previous match", down: "Next match" },
}: Props) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusToken]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const down = event.shiftKey === enterGoesUp;
    onStep(down ? 1 : -1);
  }

  const count = summary?.text ?? (results.count > 0 ? `${results.index + 1} of ${results.count}` : "");
  const tone = summary?.empty ? "text-danger" : "text-text-muted";

  return (
    <div data-find-bar className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-lg bg-surface p-1 shadow-float">
      <input
        ref={input}
        value={query}
        aria-label={label}
        placeholder="Find"
        spellCheck={false}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
        className="h-7 w-48 bg-transparent px-2 text-[13px] text-text caret-text outline-none"
      />
      <span
        data-find-count
        aria-live="polite"
        className={`min-w-16 px-1 text-right text-[11px] whitespace-nowrap tabular-nums transition-opacity ${tone} ${summary?.busy ? "opacity-50" : ""}`}
      >
        {count}
      </span>
      <Step label={stepLabels.up} disabled={summary?.empty === true} onClick={() => onStep(-1)}>
        <ChevronUpIcon className="size-4" />
      </Step>
      <Step label={stepLabels.down} disabled={summary?.empty === true} onClick={() => onStep(1)}>
        <ChevronDownIcon className="size-4" />
      </Step>
      <Step label="Close find" onClick={onClose}>
        <XIcon className="size-4" />
      </Step>
    </div>
  );
}

type StepProps = { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode };

function Step({ label, disabled = false, onClick, children }: StepProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-icon hover:bg-hover hover:text-text disabled:text-placeholder disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
