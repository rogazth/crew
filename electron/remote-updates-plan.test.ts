import { describe, expect, it } from "vitest";
import { decide, FRESH, IDLE_FOR_MS, RETRY_AFTER_MS, type Look } from "./remote-updates-plan";

const look = (over: Partial<Look> = {}): Look => ({ version: "0.3.12", agentsRunning: 0, target: "0.3.29", auto: true, now: 1_000_000, ...over });

describe("remote updates", () => {
  it("leaves a machine that is up to date, or newer, alone", () => {
    expect(decide(look({ version: "0.3.29" }), FRESH).action).toBe("none");
    // A second Mac on an older Crew never takes a machine down a version.
    expect(decide(look({ version: "0.4.0" }), FRESH).action).toBe("none");
    expect(decide(look({ version: "" }), FRESH).action).toBe("none");
  });

  it("clears a queued update once the machine is up to date", () => {
    const { memory } = decide(look({ version: "0.3.29" }), { ...FRESH, queued: true });
    expect(memory.queued).toBe(false);
  });

  it("does nothing on its own with the setting off", () => {
    expect(decide(look({ auto: false }), FRESH).action).toBe("none");
  });

  // Updating stops crewd, and every turn running there with it.
  it("waits while a session works there", () => {
    expect(decide(look({ agentsRunning: 2 }), FRESH).action).toBe("wait");
    expect(decide(look({ agentsRunning: 1, auto: false }), { ...FRESH, queued: true }).action).toBe("wait");
  });

  it("updates on its own only once the machine stayed idle a while", () => {
    const first = decide(look(), FRESH);
    expect(first).toEqual({ action: "wait", memory: { ...FRESH, idleSince: 1_000_000 } });
    expect(decide(look({ now: 1_000_000 + IDLE_FOR_MS - 1 }), first.memory).action).toBe("wait");
    expect(decide(look({ now: 1_000_000 + IDLE_FOR_MS }), first.memory).action).toBe("update");
  });

  it("starts the idle wait over when a session starts working", () => {
    const idle = decide(look(), FRESH).memory;
    const busy = decide(look({ agentsRunning: 1, now: 1_000_000 + IDLE_FOR_MS }), idle);
    expect(busy.memory.idleSince).toBeNull();
    expect(decide(look({ now: 1_000_000 + IDLE_FOR_MS + 1 }), busy.memory).action).toBe("wait");
  });

  it("updates as soon as the last session is done when the user asked for it", () => {
    expect(decide(look({ auto: false }), { ...FRESH, queued: true }).action).toBe("update");
  });

  it("holds back a version that failed or was cancelled, then tries it again", () => {
    const held = { ...FRESH, heldBack: { version: "0.3.29", at: 1_000_000 } };
    expect(decide(look(), held).action).toBe("none");
    expect(decide(look({ now: 1_000_000 + RETRY_AFTER_MS }), held).action).toBe("wait");
    // A newer version is not held back by an older one's failure.
    expect(decide(look({ target: "0.3.30" }), held).action).toBe("wait");
    // Asking for it again goes past the hold.
    expect(decide(look(), { ...held, queued: true }).action).toBe("update");
  });
});
