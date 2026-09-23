// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "../test/renderHook";
import { usePages } from "./usePages";

describe("usePages", () => {
  it("starts on the workspace", () => {
    const hook = renderHook(() => usePages());
    expect(hook.result.current.page).toEqual({ kind: "workspace" });
    expect(hook.result.current.isWorkspace).toBe(true);
    expect(hook.result.current.isRoutines).toBe(false);
    expect(hook.result.current.settings).toBeNull();
    hook.unmount();
  });

  it("closes a page with the same key that opened it", () => {
    const hook = renderHook(() => usePages());
    act(() => hook.result.current.toggle({ kind: "search" }));
    expect(hook.result.current.page).toEqual({ kind: "search" });
    expect(hook.result.current.isWorkspace).toBe(false);
    act(() => hook.result.current.toggle({ kind: "search" }));
    expect(hook.result.current.page).toEqual({ kind: "workspace" });
    hook.unmount();
  });

  it("switches straight to another page", () => {
    const hook = renderHook(() => usePages());
    act(() => hook.result.current.toggle({ kind: "search" }));
    act(() => hook.result.current.toggle({ kind: "settings", section: "about" }));
    expect(hook.result.current.settings).toBe("about");
    hook.unmount();
  });

  it("opens settings on the default section or the one asked for", () => {
    const hook = renderHook(() => usePages());
    act(() => hook.result.current.openSettings());
    expect(hook.result.current.settings).toBe("general");
    act(() => hook.result.current.openSettings("terminal"));
    expect(hook.result.current.page).toEqual({ kind: "settings", section: "terminal" });
    hook.unmount();
  });

  it("opens routines on the list, or already drafting one for an agent", () => {
    const hook = renderHook(() => usePages());
    act(() => hook.result.current.openRoutines());
    expect(hook.result.current.page).toEqual({ kind: "routines", draft: null });
    expect(hook.result.current.isRoutines).toBe(true);

    act(() => hook.result.current.openRoutines("s1"));
    const page = hook.result.current.page;
    expect(page.kind === "routines" ? page.draft : null).toMatchObject({
      sessionId: "s1",
      name: "",
      enabled: true,
      runs: [],
    });
    hook.unmount();
  });

  it("closes any page back to the workspace", () => {
    const hook = renderHook(() => usePages());
    act(() => hook.result.current.openSettings());
    act(() => hook.result.current.close());
    expect(hook.result.current.isWorkspace).toBe(true);
    hook.unmount();
  });
});
