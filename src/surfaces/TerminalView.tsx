import type { Session } from "../lib/types";

type Props = { session: Session };

export function TerminalView({ session }: Props) {
  return (
    <div
      data-selectable
      className="h-full overflow-hidden bg-canvas p-4 font-mono text-[12px]"
    >
      <p className="text-placeholder">
        <span className="text-text">{session.name}</span> — pty not wired yet
      </p>
      <p className="mt-1 text-placeholder">
        Will spawn <span className="text-text">{session.provider}</span> in the
        workspace directory.
      </p>
    </div>
  );
}
