// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LANGS } from "../lib/highlighting";
import { mount } from "../test/dom";
import { act } from "../test/renderHook";
import { DiffsPool } from "./DiffsPool";

type ProviderProps = {
  children: ReactNode;
  poolOptions: { workerFactory: () => unknown; poolSize: number };
  highlighterOptions: { langs: unknown };
};

const seen = vi.hoisted(() => ({ provider: [] as ProviderProps[], workers: 0, reads: 0, broken: false }));

vi.mock("@pierre/diffs/react", () => {
  function WorkerPoolContextProvider(props: ProviderProps) {
    seen.provider.push(props);
    return props.children;
  }
  return {
    // A chunk that fails to evaluate surfaces where the pool reads it.
    get WorkerPoolContextProvider() {
      seen.reads += 1;
      if (seen.broken) throw new Error("chunk failed to load");
      return WorkerPoolContextProvider;
    },
  };
});

vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: class FakeWorker {
    constructor() {
      seen.workers += 1;
    }
  },
}));

/** The pool's own imports settle no later than these, then it takes a few ticks to set state. */
async function loaded() {
  await act(async () => {
    await Promise.all([import("@pierre/diffs/react"), import("@pierre/diffs/worker/worker.js?worker")]);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function hasChild(root: HTMLElement): boolean {
  return root.querySelector("[aria-label=child]") !== null;
}

beforeEach(() => {
  seen.provider.length = 0;
  seen.workers = 0;
  seen.reads = 0;
  seen.broken = false;
});

describe("DiffsPool", () => {
  it("renders its children before the pool arrives", async () => {
    const view = mount(
      <DiffsPool>
        <input aria-label="child" />
      </DiffsPool>,
    );
    expect(hasChild(view.container)).toBe(true);
    expect(seen.provider).toHaveLength(0);
    await loaded();
    view.unmount();
  });

  it("wraps the children in a pool of four workers once it loads", async () => {
    const view = mount(
      <DiffsPool>
        <input aria-label="child" />
      </DiffsPool>,
    );
    await loaded();
    expect(seen.reads).toBe(1);
    const props = seen.provider.at(-1);
    expect(props?.poolOptions.poolSize).toBe(4);
    expect(props?.highlighterOptions.langs).toBe(LANGS);
    expect(hasChild(view.container)).toBe(true);
    expect(seen.workers).toBe(0);
    props?.poolOptions.workerFactory();
    props?.poolOptions.workerFactory();
    expect(seen.workers).toBe(2);
    view.unmount();
  });

  it("keeps the children bare when the pool fails to load", async () => {
    seen.broken = true;
    const view = mount(
      <DiffsPool>
        <input aria-label="child" />
      </DiffsPool>,
    );
    await loaded();
    expect(seen.reads).toBe(1);
    expect(seen.provider).toHaveLength(0);
    expect(hasChild(view.container)).toBe(true);
    view.unmount();
  });

  it("does not install the pool after it has unmounted", async () => {
    const view = mount(<DiffsPool>child</DiffsPool>);
    view.unmount();
    await loaded();
    expect(seen.reads).toBe(0);
    expect(seen.provider).toHaveLength(0);
  });
});
