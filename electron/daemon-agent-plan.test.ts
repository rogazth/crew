import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_LABEL,
  CHILD_NOTICE,
  classify,
  decideLaunch,
  HUNG_STRIKES,
  installNeeded,
  launchctlTarget,
  mismatchNotice,
  nextStep,
  parseDaemonFile,
  parsePlistJson,
  plistPath,
  sameDaemon,
  translocated,
  TRANSLOCATED_NOTICE,
  watchStep,
  type DaemonFile,
} from "./daemon-agent-plan";

const file = (over: Partial<DaemonFile> = {}): DaemonFile => ({
  url: "ws://127.0.0.1:5000",
  token: "w",
  socket: "/d/crew.sock",
  userToken: "u",
  version: "0.1.7",
  pid: 42,
  ...over,
});

const { pid: _pid, ...noPid } = file();

describe("the label", () => {
  it("is the app's bundle id, like the plist the CLI writes", () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8")) as { build: { appId: string } };
    expect(AGENT_LABEL).toBe(`${pkg.build.appId}.crewd`);
    // Out of ~/Library/LaunchAgents, so login never loads it.
    expect(plistPath("/Users/me/Library/Application Support/Crew")).toBe(
      `/Users/me/Library/Application Support/Crew/${AGENT_LABEL}.plist`,
    );
    expect(launchctlTarget(501)).toEqual({ domain: "gui/501", service: `gui/501/${AGENT_LABEL}` });
  });
});

describe("parseDaemonFile", () => {
  it("reads what crewd writes, with or without a pid", () => {
    expect(parseDaemonFile(JSON.stringify(file()))).toEqual(file());
    expect(parseDaemonFile(JSON.stringify(noPid))).toEqual(noPid);
  });

  it("refuses half a file or something else", () => {
    expect(parseDaemonFile("{")).toBeNull();
    expect(parseDaemonFile("null")).toBeNull();
    expect(parseDaemonFile(JSON.stringify({ ...file(), userToken: "" }))).toBeNull();
  });
});

describe("installNeeded", () => {
  const want = { program: "/Applications/Crew.app/Contents/Resources/crewd", dataDir: "/Users/me/Library/Application Support/Crew" };

  it("installs when there is no plist, or one that does not read", () => {
    expect(installNeeded(null, want)).toBe(true);
    expect(installNeeded({ program: want.program, dataDir: null }, want)).toBe(true);
  });

  it("reinstalls when the app moved or another copy wrote it", () => {
    expect(installNeeded({ program: "/Users/me/Downloads/Crew.app/Contents/Resources/crewd", dataDir: want.dataDir }, want)).toBe(true);
    expect(installNeeded({ program: want.program, dataDir: "/elsewhere" }, want)).toBe(true);
  });

  it("leaves the plist alone when it runs this bundle's crewd for this data dir", () => {
    expect(installNeeded({ program: want.program, dataDir: `${want.dataDir}/` }, want)).toBe(false);
  });

  // The plist holds the crewd `crew daemon install` resolved; the app used to
  // compare its own spelling and reinstall on every launch.
  it("compares both sides as they resolve on disk", () => {
    const real = (p: string) => p.replace("/Applications/Crew.app", "/Volumes/Apps/Crew.app");
    const resolved = { program: real(want.program), dataDir: want.dataDir };
    expect(installNeeded(resolved, want)).toBe(true);
    expect(installNeeded(resolved, want, real)).toBe(false);
  });

  it("sees through a real symlink with realpath", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crew-plan-"));
    mkdirSync(path.join(dir, "real"));
    writeFileSync(path.join(dir, "real/crewd"), "");
    symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
    const installed = { program: realpathSync(path.join(dir, "real/crewd")), dataDir: dir };
    expect(installNeeded(installed, { program: path.join(dir, "link/crewd"), dataDir: dir }, realpathSync)).toBe(false);
  });

  it("reads the plist through plutil's JSON", () => {
    const json = JSON.stringify({
      Label: AGENT_LABEL,
      ProgramArguments: [want.program, "--data-dir", want.dataDir, "--supervised-by", "launchd"],
      RunAtLoad: true,
    });
    expect(parsePlistJson(json)).toEqual(want);
    expect(parsePlistJson(JSON.stringify({ ProgramArguments: ["/crewd"] }))).toEqual({ program: "/crewd", dataDir: null });
    expect(parsePlistJson(JSON.stringify({ Label: "x" }))).toBeNull();
    expect(parsePlistJson("not json")).toBeNull();
  });
});

describe("translocated", () => {
  it("tells a bundle Gatekeeper moved from one the user put somewhere", () => {
    expect(translocated("/private/var/folders/xy/abc123/T/AppTranslocation/0F1E-22/d/Crew.app/Contents/Resources")).toBe(true);
    expect(translocated("/var/folders/xy/abc123/T/AppTranslocation/0F1E-22/d/Crew.app/Contents/Resources")).toBe(true);
    expect(translocated("/Applications/Crew.app/Contents/Resources")).toBe(false);
    expect(translocated("/Users/me/Downloads/AppTranslocation/Crew.app/Contents/Resources")).toBe(false);
  });

  it("runs crewd as the child, with a notice to move Crew", () => {
    const launch = decideLaunch({ ok: false, error: "translocated", notice: TRANSLOCATED_NOTICE }, { ok: true });
    expect(launch).toEqual({ run: "child", notice: TRANSLOCATED_NOTICE, why: "translocated" });
    expect(TRANSLOCATED_NOTICE).toContain("Move Crew to Applications");
  });
});

describe("classify and nextStep", () => {
  it("connects to a daemon of this version that answers", () => {
    const found = classify(file(), { alive: true, answers: true }, "0.1.7");
    expect(found).toEqual({ kind: "ready", file: file() });
    expect(nextStep(found)).toEqual({ do: "connect", file: file() });
  });

  it("starts one when there is no file", () => {
    expect(nextStep(classify(null, { alive: null, answers: false }, "0.1.7"))).toEqual({ do: "start" });
  });

  // The file is crewd's to replace: removing it raced a crewd that had just
  // written a fresh one.
  it("starts one over a file whose daemon died, and leaves the file be", () => {
    const found = classify(file(), { alive: false, answers: false }, "0.1.7");
    expect(found.kind).toBe("stale");
    expect(nextStep(found)).toEqual({ do: "start" });
  });

  it("restarts one that is alive but does not answer", () => {
    expect(nextStep(classify(file(), { alive: true, answers: false }, "0.1.7"))).toEqual({ do: "restart" });
    // No pid to check: not answering is all there is to go on.
    expect(nextStep(classify(noPid, { alive: null, answers: false }, "0.1.7"))).toEqual({ do: "restart" });
  });

  it("replaces one of another version, however it got there", () => {
    const old = file({ version: "0.1.6" });
    expect(nextStep(classify(old, { alive: true, answers: true }, "0.1.7"))).toEqual({ do: "replace", file: old });
  });
});

describe("watchStep", () => {
  const current = file();

  it("keeps the daemon it is connected to", () => {
    expect(watchStep({ kind: "ready", file: current }, current, 0)).toEqual({ do: "keep" });
  });

  it("switches to a new one: launchd brought it back, or `crew daemon restart` did", () => {
    const next = file({ url: "ws://127.0.0.1:6000", pid: 43 });
    expect(sameDaemon(next, current)).toBe(false);
    expect(watchStep({ kind: "ready", file: next }, current, 0)).toEqual({ do: "switch", file: next });
  });

  it("gives a silent daemon a few checks before taking it for hung", () => {
    const found = { kind: "unreachable", file: current } as const;
    expect(watchStep(found, current, 0)).toEqual({ do: "wait" });
    expect(watchStep(found, current, HUNG_STRIKES - 1)).toEqual({ do: "restart" });
  });

  it("starts one when the daemon stopped (`crew daemon stop`) or crashed", () => {
    expect(watchStep({ kind: "missing" }, current, 0)).toEqual({ do: "start" });
    expect(watchStep({ kind: "stale", file: current }, current, 0)).toEqual({ do: "start" });
  });

  // It used to fall through to replace: every process stopped, then launchd
  // ran the plist's crewd, that same other version, every ten seconds.
  it("never replaces another version: it says so once, then leaves it", () => {
    const other = file({ version: "0.1.8", url: "ws://127.0.0.1:7000", pid: 44 });
    const found = { kind: "mismatch", file: other } as const;
    expect(watchStep(found, current, 0)).toEqual({ do: "warn", file: other });
    expect(watchStep(found, current, 0, "0.1.8")).toEqual({ do: "leave" });
    expect(watchStep({ kind: "mismatch", file: file({ version: "0.1.9" }) }, current, 0, "0.1.8").do).toBe("warn");
    expect(mismatchNotice("0.1.8", "0.1.7")).toMatch(/0\.1\.8[\s\S]*0\.1\.7[\s\S]*open it again/);
  });
});

describe("decideLaunch", () => {
  it("uses the LaunchAgent when it came up", () => {
    expect(decideLaunch({ ok: true })).toEqual({ run: "agent" });
  });

  it("falls back to a child when the agent could not be installed or reached", () => {
    const agent = { ok: false, error: "launchctl bootstrap: 5: Input/output error" } as const;
    expect(decideLaunch(agent)).toEqual({ run: "try-child" });
    expect(decideLaunch(agent, { ok: true })).toEqual({ run: "child", notice: CHILD_NOTICE, why: agent.error });
    expect(CHILD_NOTICE).toContain("stop when Crew quits");
  });

  it("gives up with both reasons only when the child fails too", () => {
    const launch = decideLaunch({ ok: false, error: "no agent" }, { ok: false, error: "crewd exited 1" });
    expect(launch.run).toBe("none");
    if (launch.run === "none") expect(launch.dialog).toMatch(/no agent[\s\S]*crewd exited 1/);
  });
});
