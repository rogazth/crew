import { useCallback, useEffect, useRef, useState } from "react";
import { getSessionBlocks, setSessionBlocks } from "../lib/api";
import { parseBlocks, settleStreaming, type Block } from "../lib/blocks";

const SAVE_MS = 400;

/** Load the durable transcript for a session and write it back as it grows. */
export function useTranscript(sessionId: string) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [ready, setReady] = useState(false);
  const loaded = useRef(false);
  const latest = useRef<Block[]>([]);

  useEffect(() => {
    loaded.current = false;
    setReady(false);
    let cancelled = false;
    getSessionBlocks(sessionId)
      .then((raw) => {
        if (cancelled) return;
        const next = settleStreaming(parseBlocks(raw));
        latest.current = next;
        setBlocks(next);
        loaded.current = true;
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        loaded.current = true;
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    latest.current = blocks;
    if (!loaded.current) return;
    const timer = window.setTimeout(() => {
      void setSessionBlocks(sessionId, JSON.stringify(latest.current)).catch(() => {});
    }, SAVE_MS);
    return () => window.clearTimeout(timer);
  }, [blocks, sessionId]);

  const replace = useCallback((next: Block[] | ((prev: Block[]) => Block[])) => {
    setBlocks((prev) => (typeof next === "function" ? next(prev) : next));
  }, []);

  return { blocks, setBlocks: replace, ready };
}
