import { describe, expect, it, vi } from "vitest";
import type { DownloadInfo } from "./bridge";
import { createDownloadStore, downloadStatus, formatBytes, isRunning, overallProgress, progressOf } from "./downloads";

const info = (id: string, patch: Partial<DownloadInfo> = {}): DownloadInfo => ({
  id,
  webContentsId: 1,
  filename: `${id}.zip`,
  url: `https://a.com/${id}.zip`,
  path: `/Downloads/${id}.zip`,
  received: 0,
  total: 100,
  state: "progressing",
  startedAt: 0,
  ...patch,
});

describe("the download store", () => {
  it("puts a new download first and updates one in place", () => {
    const store = createDownloadStore();
    store.upsert(info("a"));
    store.upsert(info("b"));
    store.upsert(info("a", { received: 50 }));
    expect(store.list().map((item) => [item.id, item.received])).toEqual([
      ["b", 0],
      ["a", 50],
    ]);
  });

  it("tells subscribers, and hands out a new list only on change", () => {
    const store = createDownloadStore();
    const cb = vi.fn();
    const stop = store.subscribe(cb);
    store.upsert(info("a"));
    const first = store.list();
    store.remove("missing");
    store.clearFinished();
    expect(store.list()).toBe(first);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
    store.upsert(info("b"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("clears what finished and keeps what runs", () => {
    const store = createDownloadStore();
    store.upsert(info("done", { state: "completed" }));
    store.upsert(info("gone", { state: "cancelled" }));
    store.upsert(info("held", { state: "paused" }));
    store.upsert(info("going"));
    store.clearFinished();
    expect(store.list().map((item) => item.id)).toEqual(["going", "held"]);
  });

  it("drops the oldest finished download past its cap, never a running one", () => {
    const store = createDownloadStore(2);
    store.upsert(info("run1"));
    store.upsert(info("old", { state: "completed" }));
    store.upsert(info("run2"));
    expect(store.list().map((item) => item.id)).toEqual(["run2", "run1"]);
    store.upsert(info("run3"));
    expect(store.list().map((item) => item.id)).toEqual(["run3", "run2", "run1"]);
  });
});

describe("isRunning", () => {
  it("counts a paused download as running", () => {
    expect(isRunning({ state: "paused" })).toBe(true);
    expect(isRunning({ state: "progressing" })).toBe(true);
    expect(isRunning({ state: "interrupted" })).toBe(false);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1500, "1.5 KB"],
    [12_345, "12 KB"],
    [4_200_000, "4.2 MB"],
    [1_000_000_000, "1.0 GB"],
    [-1, ""],
    [Number.NaN, ""],
  ])("%d → %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("progress", () => {
  it("is a fraction of the size, or null without one", () => {
    expect(progressOf({ received: 25, total: 100 })).toBe(0.25);
    expect(progressOf({ received: 150, total: 100 })).toBe(1);
    expect(progressOf({ received: 25, total: 0 })).toBeNull();
  });

  it("combines what runs, ignoring what finished", () => {
    expect(
      overallProgress([
        info("a", { received: 50, total: 100 }),
        info("b", { received: 150, total: 300 }),
        info("c", { state: "completed", received: 0, total: 1000 }),
      ]),
    ).toBe(0.5);
    expect(overallProgress([info("a", { total: 0 })])).toBeNull();
    expect(overallProgress([info("a", { state: "completed" })])).toBeNull();
  });
});

describe("downloadStatus", () => {
  it("says how far along, and how it ended", () => {
    expect(downloadStatus(info("a", { received: 4_200_000, total: 10_000_000 }))).toBe("4.2 MB of 10 MB");
    expect(downloadStatus(info("a", { received: 4_200_000, total: 0 }))).toBe("4.2 MB");
    expect(downloadStatus(info("a", { state: "paused", received: 1000, total: 2000 }))).toBe("Paused · 1.0 KB of 2.0 KB");
    expect(downloadStatus(info("a", { state: "completed", received: 2000, total: 2000 }))).toBe("2.0 KB");
    expect(downloadStatus(info("a", { state: "cancelled" }))).toBe("Cancelled");
    expect(downloadStatus(info("a", { state: "interrupted" }))).toBe("Failed");
  });
});
