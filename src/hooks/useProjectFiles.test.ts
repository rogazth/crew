// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../lib/types";
import { deferred, type Deferred } from "../test/deferred";
import { fake } from "../test/fakeClient";
import { act, renderHook } from "../test/renderHook";
import { useProjectFiles } from "./useProjectFiles";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

const file = (cwd: string, relative: string): ProjectFile => ({
  name: relative.split("/").pop() ?? relative,
  path: `${cwd}/${relative}`,
  relative,
});

const alpha = [file("/alpha", "src/main.ts"), file("/alpha", "README.md")];
const beta = [file("/beta", "lib.rs")];

/** Answers each list_project_files request with a gate the test opens, one per cwd. */
function gated() {
  const gates = new Map<string, Deferred<ProjectFile[]>>();
  const gate = (cwd: string) => {
    const found = gates.get(cwd) ?? deferred<ProjectFile[]>();
    gates.set(cwd, found);
    return found;
  };
  fake.respond("list_project_files", (params) => gate(params.cwd as string).promise);
  return gate;
}

describe("useProjectFiles", () => {
  beforeEach(() => fake.reset());

  it("has no files and asks for none without a workspace", () => {
    const hook = renderHook(() => useProjectFiles(null));
    expect(hook.result.current).toEqual([]);
    expect(fake.sent("list_project_files")).toEqual([]);
    hook.unmount();
  });

  it("serves the same empty list while loading", () => {
    const hook = renderHook((cwd: string | null) => useProjectFiles(cwd), null);
    const none = hook.result.current;
    hook.rerender("/alpha");
    expect(hook.result.current).toBe(none);
    hook.unmount();
  });

  it("loads the workspace's files once", async () => {
    const gate = gated();
    const hook = renderHook((cwd: string | null) => useProjectFiles(cwd), "/alpha");
    expect(fake.sent("list_project_files")).toEqual([{ cwd: "/alpha" }]);
    await act(async () => gate("/alpha").resolve(alpha));
    expect(hook.result.current).toEqual(alpha);
    hook.rerender("/alpha");
    expect(fake.sent("list_project_files")).toHaveLength(1);
    hook.unmount();
  });

  it("drops a listing that lands after the workspace changed", async () => {
    const gate = gated();
    const hook = renderHook((cwd: string | null) => useProjectFiles(cwd), "/alpha");
    hook.rerender("/beta");
    await act(async () => gate("/alpha").resolve(alpha));
    expect(hook.result.current).toEqual([]);
    await act(async () => gate("/beta").resolve(beta));
    expect(hook.result.current).toEqual(beta);
    hook.unmount();
  });

  it("keeps the new workspace's files when the old listing lands last", async () => {
    const gate = gated();
    const hook = renderHook((cwd: string | null) => useProjectFiles(cwd), "/alpha");
    hook.rerender("/beta");
    await act(async () => gate("/beta").resolve(beta));
    await act(async () => gate("/alpha").resolve(alpha));
    expect(hook.result.current).toEqual(beta);
    hook.unmount();
  });

  it("keeps a late failure for the old workspace from clearing the new one", async () => {
    const gate = gated();
    const hook = renderHook((cwd: string | null) => useProjectFiles(cwd), "/alpha");
    hook.rerender("/beta");
    await act(async () => gate("/beta").resolve(beta));
    await act(async () => gate("/alpha").reject(new Error("gone")));
    expect(hook.result.current).toEqual(beta);
    hook.unmount();
  });

  it("never shows the old workspace's files while the new one loads", async () => {
    const gate = gated();
    const hook = renderHook((cwd: string | null) => useProjectFiles(cwd), "/alpha");
    await act(async () => gate("/alpha").resolve(alpha));
    hook.rerender("/beta");
    expect(hook.result.current).toEqual([]);
    hook.rerender(null);
    expect(hook.result.current).toEqual([]);
    hook.unmount();
  });

  it("has no files when the listing fails", async () => {
    const hook = renderHook(() => useProjectFiles("/alpha"));
    await act(async () => fake.take("list_project_files").reject(new Error("not a directory")));
    expect(hook.result.current).toEqual([]);
    hook.unmount();
  });

  it("asks again when the workspace comes back after a failure", async () => {
    const hook = renderHook((cwd: string | null) => useProjectFiles(cwd), "/alpha");
    await act(async () => fake.take("list_project_files").reject(new Error("busy")));
    hook.rerender(null);
    hook.rerender("/alpha");
    await act(async () => fake.take("list_project_files").resolve(alpha));
    expect(hook.result.current).toEqual(alpha);
    hook.unmount();
  });

  it("drops a listing that lands after unmount", async () => {
    const hook = renderHook(() => useProjectFiles("/alpha"));
    const request = fake.take("list_project_files");
    hook.unmount();
    const renders = hook.renders();
    await act(async () => request.resolve(alpha));
    expect(hook.renders()).toBe(renders);
  });
});
