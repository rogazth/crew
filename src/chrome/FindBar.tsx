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
  onStep: (delta: number) => void;
  onClose: () => void;
};

/** The find field that floats over a terminal or a page. */
export function FindBar({ label, query, results, focusToken, onQuery, onStep, onClose }: Props) {
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
    onStep(event.shiftKey ? -1 : 1);
  }

  const count = results.count > 0 ? `${results.index + 1} of ${results.count}` : "";

  return (
    <div className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-lg bg-surface p-1 shadow-float">
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
      <span className="min-w-12 px-1 text-right text-[11px] tabular-nums text-text-muted">
        {count}
      </span>
      <Step label="Previous match" onClick={() => onStep(-1)}>
        <ChevronUpIcon className="size-4" />
      </Step>
      <Step label="Next match" onClick={() => onStep(1)}>
        <ChevronDownIcon className="size-4" />
      </Step>
      <Step label="Close find" onClick={onClose}>
        <XIcon className="size-4" />
      </Step>
    </div>
  );
}

type StepProps = { label: string; onClick: () => void; children: React.ReactNode };

function Step({ label, onClick, children }: StepProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-icon hover:bg-hover hover:text-text"
    >
      {children}
    </button>
  );
}
