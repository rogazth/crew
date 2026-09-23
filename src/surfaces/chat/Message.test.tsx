// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../lib/blocks";
import { click, mount, only, type Mounted } from "../../test/dom";
import { ChatContext } from "./context";
import { UserMessage } from "./Message";

vi.mock("../../lib/client", async () => ({ client: (await import("../../test/fakeClient")).fake.client }));
vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});

let view: Mounted | null = null;
const openPath = vi.fn<(path: string) => void>();
const openSession = vi.fn<(id: string) => void>();

function render(block: Block) {
  view = mount(
    <ChatContext.Provider value={{ openPath, openSession, files: [] }}>
      <UserMessage block={block} />
    </ChatContext.Provider>,
  );
}

beforeEach(() => {
  openPath.mockClear();
  openSession.mockClear();
});
afterEach(() => {
  view?.unmount();
  view = null;
});

describe("UserMessage", () => {
  it("opens a file the message mentions", () => {
    render({ id: "u", role: "user", text: "look at @src/lib/tabs.ts please" });
    click(only(view!.container, 'button[title="src/lib/tabs.ts"]'));
    expect(openPath).toHaveBeenCalledWith("src/lib/tabs.ts");
  });

  it("opens the agent that wrote a letter, once it is unfolded", () => {
    render({ id: "u", role: "user", text: "\nBuild is green.\nDetails follow.", fromAgent: { id: "s9", name: "Grace" } });
    click(only(view!.container, '[data-block="u"]'));
    click(only(view!.container, 'button[title="Open Grace"]'));
    expect(openSession).toHaveBeenCalledWith("s9");
  });
});
