import { useEffect, useRef, useState } from "react";

type Props = {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
};

/** Inline session rename. Native input so autofocus is not swallowed by a field wrapper. */
export function RenameRow({ initial, onCommit, onCancel, className = "" }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);

  useEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.select();
  }, []);

  function finish(commit: boolean) {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  }

  return (
    <div className={`flex w-full min-w-0 items-center rounded-lg bg-selected ${className}`}>
      <input
        ref={ref}
        autoFocus
        value={value}
        aria-label="Rename"
        className="h-auto w-full min-w-0 rounded-md bg-kumo-fill px-2 py-1 text-[13px] font-semibold text-kumo-default caret-kumo-default outline-none ring-1 ring-kumo-interact"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          }
        }}
      />
    </div>
  );
}
