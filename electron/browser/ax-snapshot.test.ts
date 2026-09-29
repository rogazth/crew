import { describe, expect, it } from "vitest";
import { formatAxTree, parseUid, type AXNode } from "./ax-snapshot";
// Recorded from Electron 44: Accessibility.getFullAXTree on a small checkout
// form, with the page's file: URL swapped for a dev server's.
import recorded from "./fixtures/checkout-ax.json";

const nodes = recorded as AXNode[];

describe("formatAxTree", () => {
  it("reads a real page as named, indented lines with a uid on each", () => {
    const { text } = formatAxTree(nodes, 1);
    expect(text).toMatchInlineSnapshot(`
      "uid=1_0 RootWebArea "Checkout" url="http://localhost:5173/checkout"
        uid=1_1 navigation
          uid=1_2 link "Home" url="http://localhost:5173/home"
          uid=1_3 link "Cart (2)" url="http://localhost:5173/cart"
        uid=1_4 main
          uid=1_5 heading "Checkout" level=1
          uid=1_6 StaticText "Shipping details"
          uid=1_7 form
            uid=1_8 textbox "Email" value="ada@example.com" required
            uid=1_9 textbox "Notes" multiline
            uid=1_10 combobox "Country" value="Peru"
              uid=1_11 option "Chile"
              uid=1_12 option "Peru" selected
            uid=1_13 checkbox "Save address" checked
            uid=1_14 button "Place order"
            uid=1_15 button "Cancel" disabled
          uid=1_16 paragraph
            uid=1_17 StaticText "Total:"
            uid=1_18 strong
              uid=1_19 StaticText "$42.00"
          uid=1_20 image "Logo""
    `);
  });

  it("drops what a person would not name: ignored nodes, wrappers, repeated text, inline boxes", () => {
    const { text } = formatAxTree(nodes, 1);
    expect(text).not.toMatch(/\bgeneric\b|\bnone\b|InlineTextBox|LabelText|MenuListPopup/);
    // A label's text sits beside its field, and a link's inside it: both repeat a name.
    expect(text.match(/"Email"/g)).toHaveLength(1);
    expect(text.match(/"Home"/g)).toHaveLength(1);
    expect(text).not.toContain("decorative");
    expect(text).not.toContain("hidden text");
  });

  it("maps each uid to its DOM node, labelled for messages", () => {
    const { uids } = formatAxTree(nodes, 7);
    const button = [...uids.entries()].find(([, target]) => target.label === 'button "Place order"');
    expect(button?.[0]).toMatch(/^7_\d+$/);
    expect(button?.[1].backendNodeId).toBe(39);
  });

  it("stops at the line cap and says how much it left out", () => {
    const many: AXNode[] = [
      { nodeId: "r", ignored: false, role: { value: "RootWebArea" }, name: { value: "Feed" }, childIds: [] },
    ];
    for (let i = 0; i < 2500; i++) {
      many[0]!.childIds!.push(`n${i}`);
      many.push({ nodeId: `n${i}`, parentId: "r", ignored: false, role: { value: "link" }, name: { value: `Post ${i}` }, backendDOMNodeId: i + 10 });
    }
    const { text, uids } = formatAxTree(many, 1);
    expect(text.split("\n")).toHaveLength(2001);
    expect(text).toMatch(/… 501 more nodes not shown/);
    // The root has no DOM node of its own here, so one line carries no uid.
    expect(uids.size).toBe(1999);
  });

  it("keeps names on one line and quotes escaped", () => {
    const tree: AXNode[] = [
      { nodeId: "1", ignored: false, role: { value: "button" }, name: { value: 'Say\n"hi"' }, backendDOMNodeId: 2 },
    ];
    expect(formatAxTree(tree, 1).text).toBe('uid=1_0 button "Say \\"hi\\""');
  });
});

describe("parseUid", () => {
  it("splits the snapshot from the node", () => {
    expect(parseUid("12_3")).toEqual({ snapshot: 12, index: 3 });
    expect(parseUid(" 1_0 ")).toEqual({ snapshot: 1, index: 0 });
    expect(parseUid("button")).toBeNull();
    expect(parseUid("1_")).toBeNull();
  });
});
