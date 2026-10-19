import { useEffect, useRef, useState } from "react";

type Props = {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
};

/** Inline session rename. Native input so the mount focus is not swallowed by a field wrapper. */
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
    // One surface: the field itself, where the row's text was, so nothing sits behind it.
    <div className={`flex w-full min-w-0 items-center ${className}`}>
      <input
        ref={ref}
        value={value}
        aria-label="Rename"
        spellCheck={false}
        className="h-7 w-full min-w-0 rounded-md bg-canvas px-2 text-[13px] text-text caret-text outline-none ring-1 ring-focus/50"
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
