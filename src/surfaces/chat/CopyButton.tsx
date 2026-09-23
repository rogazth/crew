import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

type Props = { text: string; className?: string };

/** Copies `text`; the check stays 1.5s so the click reads as done. */
export function CopyButton({ text, className }: Props) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(timer);
  }, [done]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
    } catch {
      setDone(false);
    }
  }

  return (
    <button
      type="button"
      aria-label={done ? "Copied" : "Copy"}
      title="Copy"
      onClick={() => void copy()}
      className={className ?? "crew-copy"}
      {...(done ? { "data-done": "" } : {})}
    >
      {done ? <CheckIcon className="size-3.5" weight="bold" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}
