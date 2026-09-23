// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { click, mount } from "../test/dom";
import { Surface } from "./Surface";

describe("Surface", () => {
  it("offers to choose a folder when there is no workspace", () => {
    const onCreateWorkspace = vi.fn();
    const view = mount(<Surface tab={null} sessions={[]} hasWorkspace={false} onCreateWorkspace={onCreateWorkspace} />);
    const choose = [...view.container.querySelectorAll("button")].find((node) => node.textContent === "Choose a folder")!;
    click(choose);
    expect(onCreateWorkspace).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
