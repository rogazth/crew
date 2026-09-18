import { useEffect, useMemo, useState } from "react";
import type { ThreadHandle, ThreadState } from "@crew/fixtures";
import { source } from "./source";

const EMPTY: ThreadState = { blocks: [], working: false, status: "idle" };

export function useThread(sessionId: string): ThreadState & { runtime: ThreadHandle } {
  const handle = useMemo(() => source.thread(sessionId), [sessionId]);
  const [state, setState] = useState<ThreadState>(() => handle.snapshot() ?? EMPTY);

  useEffect(() => {
    setState(handle.snapshot() ?? EMPTY);
    // `subscribe` calls the listener synchronously before it returns, so the
    // unsubscribe function does not exist yet inside that first call.
    const box: { off: (() => void) | null } = { off: null };
    box.off = handle.subscribe(setState);
    return () => box.off?.();
  }, [handle]);

  return { ...state, runtime: handle };
}
