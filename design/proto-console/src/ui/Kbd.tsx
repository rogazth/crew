import clsx from "clsx";
import { commandKeys, formatChord, type CommandId } from "@crew/fixtures";
import { useApp } from "@/lib/store";

/** A keycap: mono, dim, 1px rule. Never larger than the text beside it. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--r)] border border-rule",
        "px-1 font-mono text-xs leading-none text-ink-3",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** The chord a command is bound to now — bindings are editable, so read the store. */
export function CommandKbd({ id, className }: { id: CommandId; className?: string }) {
  const chord = useApp().keys[id];
  return <Kbd className={className}>{chord ? formatChord(chord) : commandKeys(id)}</Kbd>;
}
