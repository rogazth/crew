import { describe, expect, it } from "vitest";
import { STATUS_ORDER, statusLabel } from "./status";

describe("status", () => {
  it("orders the statuses that need a human first", () => {
    expect(STATUS_ORDER).toEqual(["needs-input", "error", "working", "done", "idle"]);
  });

  it("labels every status, calling done unread", () => {
    expect(STATUS_ORDER.map(statusLabel)).toEqual(["Needs input", "Error", "Working", "Unread", "Idle"]);
  });
});
