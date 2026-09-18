import { COMMAND_IDS, COMMANDS, formatChord, type CommandGroup, type CommandId } from "@crew/fixtures";
import { Dialog, DialogHeader, Kbd } from "@/ui";
import { store, useApp } from "@/lib/store";

const EXTRA: Array<{ group: string; label: string; keys: string }> = [
  { group: "Palette", label: "Route to actions", keys: ">" },
  { group: "Palette", label: "Route to agents", keys: "@" },
  { group: "Palette", label: "Route to messages", keys: "#" },
  { group: "Palette", label: "Go to line", keys: ":" },
  { group: "List", label: "Move focus", keys: "↑ ↓" },
  { group: "List", label: "Open", keys: "⏎" },
  { group: "List", label: "Preview", keys: "Space" },
  { group: "List", label: "Rename", keys: "F2" },
  { group: "List", label: "Delete", keys: "d d" },
  { group: "List", label: "Clear selection", keys: "Esc" },
  { group: "Chat", label: "Send", keys: "⏎" },
  { group: "Chat", label: "Newline", keys: "⇧⏎" },
  { group: "Chat", label: "Mention a file", keys: "@" },
  { group: "Chat", label: "Answer the hot card", keys: "⏎ / Esc" },
  { group: "View", label: "This sheet", keys: "?" },
];

export function ShortcutSheet() {
  const state = useApp();
  const open = state.overlay?.kind === "shortcuts";

  const groups = new Map<string, Array<{ label: string; keys: string }>>();
  for (const id of COMMAND_IDS as CommandId[]) {
    const def = COMMANDS[id];
    const group: CommandGroup = def.group;
    const chord = state.keys[id] ?? def.keys;
    const list = groups.get(group) ?? [];
    list.push({ label: def.label, keys: formatChord(chord) });
    groups.set(group, list);
  }
  for (const entry of EXTRA) {
    const list = groups.get(entry.group) ?? [];
    list.push({ label: entry.label, keys: entry.keys });
    groups.set(entry.group, list);
  }

  return (
    <Dialog
      open={open}
      onClose={() => store.closeOverlay()}
      label="Keyboard shortcuts"
      className="max-w-[760px]"
    >
      <DialogHeader>
        <span>Keyboard</span>
        <span className="ml-auto normal-case">
          <Kbd>?</Kbd>
        </span>
      </DialogHeader>
      <div className="scroll min-h-0 flex-1 columns-2 gap-6 p-4">
        {[...groups].map(([group, entries]) => (
          <section key={group} className="mb-5 break-inside-avoid">
            <h3 className="mb-1 font-mono text-xs tracking-wide text-ink-4 uppercase">{group}</h3>
            <dl className="flex flex-col">
              {entries.map((entry) => (
                <div
                  key={`${group}-${entry.label}`}
                  className="flex items-center justify-between gap-4 border-b border-rule py-1 last:border-b-0"
                >
                  <dt className="truncate text-md text-ink-2">{entry.label}</dt>
                  <dd className="shrink-0">
                    <Kbd>{entry.keys}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
