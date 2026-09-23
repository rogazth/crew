// @vitest-environment happy-dom
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { deferred } from "./deferred";
import { click, mount, only, press, type } from "./dom";
import { fake } from "./fakeClient";
import { FakeSocket } from "./fakeSocket";
import { act, renderHook } from "./renderHook";

describe("renderHook", () => {
  it("exposes the latest value and rerenders with new props", () => {
    const hook = renderHook((n: number) => n * 2, 2);
    expect(hook.result.current).toBe(4);
    hook.rerender(5);
    expect(hook.result.current).toBe(10);
    expect(hook.renders()).toBe(2);
    hook.unmount();
  });

  it("flushes state set after a promise settles", async () => {
    const gate = deferred<string>();
    const hook = renderHook(() => {
      const [value, setValue] = useState("idle");
      useEffect(() => {
        void gate.promise.then(setValue);
      }, []);
      return value;
    });
    expect(hook.result.current).toBe("idle");
    await act(async () => gate.resolve("done"));
    expect(hook.result.current).toBe("done");
    hook.unmount();
  });

  it("runs effect cleanups on unmount", () => {
    let cleaned = false;
    const hook = renderHook(() =>
      useEffect(
        () => () => {
          cleaned = true;
        },
        [],
      ),
    );
    hook.unmount();
    expect(cleaned).toBe(true);
  });
});

describe("fake client", () => {
  beforeEach(() => fake.reset());

  it("parks requests until the test answers them", async () => {
    const pending = fake.client.request<number>("thing_get", { id: "a" });
    const request = fake.take("thing_get");
    expect(request.params).toEqual({ id: "a" });
    request.resolve(7);
    await expect(pending).resolves.toBe(7);
  });

  it("answers through a responder and records what was sent", async () => {
    fake.respond("thing_get", ({ id }) => `got ${String(id)}`);
    await expect(fake.client.request("thing_get", { id: "b" })).resolves.toBe("got b");
    expect(fake.sent("thing_get")).toEqual([{ id: "b" }]);
  });

  it("delivers events until the listener unsubscribes", () => {
    const seen: unknown[] = [];
    const off = fake.client.on("tick", (payload) => seen.push(payload));
    fake.emit("tick", 1);
    off();
    fake.emit("tick", 2);
    expect(seen).toEqual([1]);
    expect(fake.listening("tick")).toBe(0);
  });
});

describe("fake socket", () => {
  it("frames binary payloads with a little-endian stream id", () => {
    const socket = new FakeSocket("ws://x");
    const frames: ArrayBuffer[] = [];
    socket.onmessage = (event) => frames.push(event.data as ArrayBuffer);
    socket.frame(258, "hi");
    const bytes = new Uint8Array(frames[0] as ArrayBuffer);
    expect([...bytes]).toEqual([2, 1, 0, 0, 104, 105]);
  });
});

describe("dom helpers", () => {
  function Form({ onSubmit }: { onSubmit: (value: string) => void }) {
    const [value, setValue] = useState("");
    return (
      <div>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit(value);
            }
          }}
        />
        <button type="button" onClick={() => onSubmit("clicked")} />
      </div>
    );
  }

  it("types, presses and clicks through React's handlers", () => {
    const submitted: string[] = [];
    const view = mount(<Form onSubmit={(value) => submitted.push(value)} />);
    const input = only<HTMLInputElement>(view.container, "input");
    type(input, "hello");
    expect(press(input, "Enter")).toBe(true);
    click(only(view.container, "button"));
    expect(submitted).toEqual(["hello", "clicked"]);
    view.unmount();
  });
});
