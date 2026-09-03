/** Commands aim at one terminal: the one filling the active tab. */
export type TerminalHandle = {
  find: () => void;
};

let current: TerminalHandle | null = null;

export function holdTerminal(handle: TerminalHandle): () => void {
  current = handle;
  return () => {
    if (current === handle) current = null;
  };
}

export function activeTerminal(): TerminalHandle | null {
  return current;
}
