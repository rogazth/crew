// What an install failure means to the person adding the machine. ssh, the
// socket check and the daemon each say it their own way; the common three get a
// hint and, where one exists, a command to fix it. Anything else keeps its words.
import type { InstallFailure, InstallStepId } from "../src/lib/remotes.ts";

/** What the person asked for, so the fix can name it. */
export type FailureContext = { destination: string; user?: string; sshPort?: number; port: number };

/** Steps that dial the machine over ssh; a failure elsewhere (upload, service, pair) is not the key or the address. */
const DIALS: readonly InstallStepId[] = ["reach", "ssh", "existing"];

export function classifyInstallFailure(message: string, context: FailureContext, step: InstallStepId): InstallFailure {
  const dials = DIALS.includes(step);
  const who = `${context.user ? `${context.user}@` : ""}${context.destination}`;
  const dial = context.sshPort ? ` -p ${context.sshPort}` : "";
  if (dials && /Permission denied \(|Too many authentication failures|Host key verification failed|no mutual signature/i.test(message)) {
    return {
      code: "auth",
      message,
      hint: "The machine did not take your SSH key. Add it there, then try again:",
      fix: `ssh-copy-id${dial} ${who}`,
    };
  }
  const port = /Port (\d+) is already in use/i.exec(message);
  if (port) {
    return {
      code: "port",
      message,
      hint: `Something else listens on port ${port[1]} there. Pick another port under Advanced options, or stop what uses it.`,
    };
  }
  if (
    dials &&
    /Could not reach \S+ on port|Could not resolve hostname|Connection (timed out|refused|closed|reset)|No route to host|Network is unreachable|Operation timed out|unknown host|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT/i.test(
      message,
    )
  ) {
    return {
      code: "unreachable",
      message,
      hint: "Check the address, that the machine is on, and that SSH listens on that port. This test should work from a terminal:",
      fix: `ssh${dial} ${who}`,
    };
  }
  return { code: "other", message, hint: "" };
}
