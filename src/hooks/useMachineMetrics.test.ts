import { describe, expect, it } from "vitest";
import { METRICS_KEPT, mergeSamples } from "./useMachineMetrics";

const sample = (at: number) => ({ at, cpuPercent: 1, memUsed: 1, memTotal: 2 });

describe("mergeSamples", () => {
  it("appends only samples newer than the last kept", () => {
    expect(mergeSamples([sample(1), sample(2)], [sample(2), sample(3)]).map((s) => s.at)).toEqual([1, 2, 3]);
  });

  it("keeps the same array when nothing is new", () => {
    const kept = [sample(5)];
    expect(mergeSamples(kept, [sample(5)])).toBe(kept);
  });

  it("drops the oldest past what the daemon keeps", () => {
    const kept = Array.from({ length: METRICS_KEPT }, (_, i) => sample(i));
    const next = mergeSamples(kept, [sample(METRICS_KEPT)]);
    expect(next).toHaveLength(METRICS_KEPT);
    expect(next[0]?.at).toBe(1);
  });
});
