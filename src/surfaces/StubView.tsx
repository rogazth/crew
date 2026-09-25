import { StubIcon } from "../chrome/StubIcon";
import type { StubKind } from "../lib/types";

const NOTES: Record<StubKind, string> = {
  terminal: "A shell in the workspace directory. pty.rs is not wired yet.",
  history: "Every page the browser has shown.",
};

export function StubView({ stub, title }: { stub: StubKind; title: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <StubIcon stub={stub} className="size-8 text-placeholder" />
      <p className="font-medium">{title}</p>
      <p className="max-w-xs text-placeholder">{NOTES[stub]}</p>
    </div>
  );
}
