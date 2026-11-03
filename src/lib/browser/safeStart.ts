import { browserHost } from "../host";

let answer: Promise<boolean> | null = null;

/**
 * Whether the launch before this one died before it settled, as main knows
 * (electron/launch-guard.ts). For this run saved pages stay cold until opened:
 * one of them may be what took the app down.
 */
export function safeStart(): Promise<boolean> {
  answer ??= browserHost()?.safeStart().catch(() => false) ?? Promise.resolve(false);
  return answer;
}
