// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

// Icons are presentation, and the barrel costs over a second to import.
vi.mock("@phosphor-icons/react", () => new Proxy({}, { has: () => true, get: (_, key) => (key === "then" ? undefined : () => null) }));

import type { RoutineEntry } from "../hooks/useRoutines";
import type { Session } from "../lib/types";
import { click, mount, only, type Mounted } from "../test/dom";
import { RoutineCard } from "./RoutineCard";

const session: Session = {
  id: "s1",
  workspaceId: "w1",
  kind: "agent",
  name: "research",
  provider: "claude",
  model: "",
  providerSessionId: null,
  description: "",
  notifications: true,
  autonomy: "ask",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
};

const entry: RoutineEntry = {
  session,
  cwd: "/code/crew",
  routine: {
    id: "r1",
    sessionId: "s1",
    name: "Digest",
    enabled: true,
    prompt: "Summarize",
    schedule: JSON.stringify({ kind: "interval", minutes: 60 }),
    lastRunAt: null,
    nextRunAt: null,
    runs: [],
    createdBy: null,
  },
};

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
});

describe("RoutineCard", () => {
  it("opens the routine on click", () => {
    const onOpen = vi.fn();
    view = mount(<RoutineCard entry={entry} workspace="storefront" onOpen={onOpen} />);
    click(only(view.container, "button"));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
