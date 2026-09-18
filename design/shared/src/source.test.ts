import { describe, expect, it } from "vitest";
import { fixtureSource, sourceFromLocation, stressSource } from "./source";
import { workspaces } from "./data/workspace";

describe("fixtureSource", () => {
  it("answers the demo world", async () => {
    const source = fixtureSource();
    expect(source.kind).toBe("fixtures");
    expect(await source.workspaces()).toHaveLength(workspaces.length);
    const sessions = await source.sessions("ws-crew");
    expect(sessions.length).toBeGreaterThan(5);
    source.dispose?.();
  });

  it("remembers a session it created", async () => {
    const source = fixtureSource();
    const created = await source.createSession("ws-crew", "agent", {
      name: "brand new",
      provider: "claude",
      model: "claude-opus-5",
      description: "",
      autonomy: "ask",
    });
    const sessions = await source.sessions("ws-crew");
    expect(sessions.some((s) => s.id === created.id)).toBe(true);
    await source.deleteSession(created.id);
    expect((await source.sessions("ws-crew")).some((s) => s.id === created.id)).toBe(false);
    source.dispose?.();
  });

  it("reads back what it wrote, rather than the file on disk", async () => {
    const source = fixtureSource();
    const path = "/Users/you/crew/src/lib/tabs.ts";
    const before = await source.readTextFile(path);
    await source.writeTextFile(path, "// replaced\n");
    expect(await source.readTextFile(path)).toBe("// replaced\n");
    expect(before).not.toBe("// replaced\n");
    source.dispose?.();
  });

  it("hands out a thread whose first listener call is synchronous", async () => {
    const source = fixtureSource();
    const handle = source.thread("s-harness");
    let calls = 0;
    // The trap every consumer hits: this fires before `subscribe` returns.
    const off = handle.subscribe(() => (calls += 1));
    expect(calls).toBe(1);
    off();
    source.dispose?.();
  });
});

describe("stressSource", () => {
  it("answers a workspace of four hundred sessions", async () => {
    const source = stressSource("heavy");
    expect(source.label).toBe("Stress · heavy");
    const sessions = await source.sessions("ws-crew");
    expect(sessions.length).toBeGreaterThan(400);
    source.dispose?.();
  });

  it("answers twenty thousand project files", async () => {
    const source = stressSource("heavy");
    expect(await source.projectFiles("/x")).toHaveLength(20_000);
    source.dispose?.();
  });

  it("holds a five-thousand-block transcript", async () => {
    const source = stressSource("heavy");
    const handle = source.thread("stress-s-0");
    expect(handle.snapshot().blocks).toHaveLength(5_000);
    source.dispose?.();
  });

  it("still resolves the demo routes, so every brief route works under stress", async () => {
    const source = stressSource("medium");
    expect(source.thread("s-harness").snapshot().blocks.length).toBeGreaterThan(10);
    source.dispose?.();
  });

  it("gives the terminal fifty thousand lines", async () => {
    const source = stressSource("light");
    expect(await source.terminal("t-build")).toHaveLength(50_000);
    source.dispose?.();
  });
});

describe("sourceFromLocation", () => {
  it("defaults to the demo fixtures", () => {
    const source = sourceFromLocation("");
    expect(source.label).toBe("Fixtures");
    source.dispose?.();
  });

  it("reads a stress preset", () => {
    const source = sourceFromLocation("?stress=medium");
    expect(source.label).toBe("Stress · medium");
    source.dispose?.();
  });

  it("ignores a preset that does not exist", () => {
    const source = sourceFromLocation("?stress=enormous");
    expect(source.label).toBe("Fixtures");
    source.dispose?.();
  });

  it("asks for live only when a live factory was given", () => {
    const withoutFactory = sourceFromLocation("?source=live");
    expect(withoutFactory.kind).toBe("fixtures");
    withoutFactory.dispose?.();

    const fake = { ...fixtureSource(), kind: "live" as const, label: "Live daemon" };
    expect(sourceFromLocation("?source=live", () => fake).label).toBe("Live daemon");
  });

  it("lets live win over a stress preset", () => {
    const fake = { ...fixtureSource(), kind: "live" as const, label: "Live daemon" };
    expect(sourceFromLocation("?source=live&stress=heavy", () => fake).kind).toBe("live");
  });
});
