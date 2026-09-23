// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, MessagePage } from "../lib/protocol";
import { forget } from "../lib/transcript";
import { fake } from "../test/fakeClient";
import { act, renderHook } from "../test/renderHook";
import { useThread } from "./useThread";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

const block = (id: string): Block => ({ id, role: "assistant", text: id });

function page(blocks: Block[], fromPos: number, more: boolean, working = false): MessagePage {
  return { blocks, fromPos, toPos: fromPos + blocks.length - 1, more, working, status: "idle", seq: 0 };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function answer(value: MessagePage) {
  fake.take("transcript_tail").resolve(value);
  await settle();
}

beforeEach(() => fake.reset());
afterEach(() => {
  for (const id of ["t1", "t2"]) forget(id);
});

describe("useThread", () => {
  it("loads the transcript tail and shows it once it lands", async () => {
    const hook = renderHook(() => useThread("t1"));
    expect(hook.result.current).toMatchObject({ blocks: [], ready: false, working: false });
    expect(fake.sent("transcript_tail")).toEqual([{ sessionId: "t1", limit: 80 }]);

    await answer(page([block("b1"), block("b2")], 5, true, true));

    expect(hook.result.current).toMatchObject({
      blocks: [block("b1"), block("b2")],
      ready: true,
      working: true,
      more: true,
      loadingEarlier: false,
      focusId: null,
    });
    hook.unmount();
  });

  it("pages towards the start and prepends what it finds", async () => {
    const hook = renderHook(() => useThread("t1"));
    await answer(page([block("b5")], 5, true));

    act(() => hook.result.current.loadEarlier());
    expect(hook.result.current.loadingEarlier).toBe(true);
    expect(fake.sent("transcript_tail").at(-1)).toEqual({ sessionId: "t1", limit: 80, beforePos: 5 });

    await answer(page([block("b3"), block("b4")], 3, false));
    expect(hook.result.current.blocks.map((b) => b.id)).toEqual(["b3", "b4", "b5"]);
    expect(hook.result.current).toMatchObject({ more: false, loadingEarlier: false });
    hook.unmount();
  });

  it("follows the session it is given", async () => {
    const hook = renderHook((id: string) => useThread(id), "t1");
    await answer(page([block("one")], 1, false));
    hook.rerender("t2");
    expect(hook.result.current.ready).toBe(false);
    await answer(page([block("two")], 1, false));
    expect(hook.result.current.blocks).toEqual([block("two")]);
    expect(fake.sent("transcript_tail").map((p) => p.sessionId)).toEqual(["t1", "t2"]);
    hook.unmount();
  });

  it("does not load a second time for a thread already in hand", async () => {
    const first = renderHook(() => useThread("t1"));
    await answer(page([block("b1")], 1, false));
    const second = renderHook(() => useThread("t1"));
    await settle();
    expect(fake.sent("transcript_tail")).toHaveLength(1);
    expect(second.result.current.blocks).toEqual([block("b1")]);
    first.unmount();
    second.unmount();
  });
});
