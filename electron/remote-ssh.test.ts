import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTailnetIp, linuxArch, remoteLayout, serviceUnit, swapBinary, writeLayoutCommand } from "./remote-ssh";

describe("linux installer", () => {
  it("maps uname to the builds Crew ships", () => {
    expect(linuxArch("aarch64\n")).toBe("arm64");
    expect(linuxArch("x86_64")).toBe("x64");
    expect(linuxArch("armv7l")).toBeNull();
  });

  it("writes a user unit that listens on the tailnet address", () => {
    const unit = serviceUnit("100.127.204.79", 17877);
    expect(unit).toContain("After=tailscaled.service");
    expect(unit).toContain("ExecStart=%h/.crew/bin/crewd serve --listen 100.127.204.79:17877 --data-dir %h/.crew/data");
    expect(unit).toContain("WantedBy=default.target");
  });

  // One CLI or build killed for memory must not stop the unit, and every session in it.
  it("keeps the daemon up when the kernel kills one of its processes for memory", () => {
    expect(serviceUnit("100.127.204.79", 17877)).toContain("\nOOMPolicy=continue\n");
  });

  // A dev or local build adding the machine the release runs on gets a crewd of its own.
  it("keeps each app's crewd apart on the machine", () => {
    const release = remoteLayout("release");
    expect(release).toEqual({ unit: "crewd", home: ".crew", port: 17877 });
    const layouts = (["release", "local", "dev"] as const).map(remoteLayout);
    for (const key of ["unit", "home", "port"] as const) {
      expect(new Set(layouts.map((layout) => layout[key])).size).toBe(3);
    }
    const dev = serviceUnit("100.127.204.79", 17881, remoteLayout("dev"));
    expect(dev).toContain("ExecStart=%h/.crew-dev/bin/crewd serve --listen 100.127.204.79:17881 --data-dir %h/.crew-dev/data");
    expect(dev).not.toContain("%h/.crew/");
  });

  // Sessions on the machine are told to run the `crew` beside crewd.
  it("links crew to crewd beside it", () => {
    const swap = swapBinary(remoteLayout("dev"));
    expect(swap).toContain('mv "$HOME/.crew-dev/bin"/crewd.new "$HOME/.crew-dev/bin"/crewd');
    expect(swap).toContain('ln -sfn crewd "$HOME/.crew-dev/bin"/crew');
  });

  it("only takes a tailnet address as the one crewd listens on", () => {
    expect(isTailnetIp("100.127.204.79")).toBe(true);
    expect(isTailnetIp("100.64.0.1")).toBe(true);
    expect(isTailnetIp("100.128.0.1")).toBe(false);
    expect(isTailnetIp("163.192.102.220")).toBe(false);
  });
});

describe("the layout a remote data dir is given", () => {
  const written = (layout: ReturnType<typeof remoteLayout>) => {
    const home = mkdtempSync(path.join(tmpdir(), "crew-remote-home-"));
    mkdirSync(path.join(home, layout.home, "data"), { recursive: true });
    const run = () => execFileSync("sh", ["-c", writeLayoutCommand(layout)], { env: { ...process.env, HOME: home } });
    run();
    const file = path.join(home, layout.home, "data", "layout.json");
    return { home, file, run, json: JSON.parse(readFileSync(file, "utf8")) };
  };

  it("keeps the release's folders where they always were", () => {
    const { home, json } = written(remoteLayout("release"));
    expect(json).toEqual({ workDir: `${home}/.crew`, homeFolder: `${home}/Crew` });
  });

  it("gives a dev build's worktrees its own folder", () => {
    const { home, json } = written(remoteLayout("dev"));
    expect(json).toEqual({ workDir: `${home}/.crew-dev` });
  });

  it("never replaces a layout the data dir already has", () => {
    const { file, run } = written(remoteLayout("release"));
    writeFileSync(file, '{"workDir":"/kept"}\n');
    run();
    expect(readFileSync(file, "utf8")).toBe('{"workDir":"/kept"}\n');
  });
});
