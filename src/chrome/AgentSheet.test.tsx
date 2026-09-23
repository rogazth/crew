// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

import type { useAgentSheet } from "../hooks/useAgentSheet";
import type { AgentDraft } from "../lib/agentSheet";
import type { Session } from "../lib/types";
import { deferred } from "../test/deferred";
import { click, mount, press, type, type Mounted } from "../test/dom";
import { fake } from "../test/fakeClient";
import { act } from "../test/renderHook";
import { AgentSheet, AgentSheetHost } from "./AgentSheet";

/** Must match CLOSE_MS in AgentSheet: the exit animation the sheet waits out before it reports closed. */
const CLOSE_MS = 150;

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "s1",
    workspaceId: "w1",
    kind: "agent",
    name: "research",
    provider: "claude",
    model: "claude-opus-5",
    providerSessionId: null,
    description: "Reads papers",
    notifications: true,
    autonomy: "ask",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

let view: Mounted | null = null;

beforeEach(() => {
  fake.reset();
  fake.respond("agent_installed", () => ["claude", "cursor-agent", "codex", "opencode"]);
  fake.respond("state_get", () => null);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.useRealTimers();
});

const settle = () => act(async () => {});

async function render(
  props: {
    session?: Session | null;
    existingNames?: string[];
    onSave?: (draft: AgentDraft) => Promise<void>;
    onNewRoutine?: (() => void) | null;
  } = {},
) {
  const onSave = vi.fn(props.onSave ?? (async () => {}));
  const onClose = vi.fn();
  view = mount(
    <AgentSheet
      session={props.session ?? null}
      existingNames={props.existingNames ?? []}
      onNewRoutine={props.onNewRoutine ?? null}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  await settle();
  return { onSave, onClose };
}

/** The control a label names, the way a screen reader finds it. */
function control<E extends HTMLElement>(label: string): E {
  const tag = [...document.body.querySelectorAll("label")].find((el) => el.textContent?.startsWith(label))!;
  return document.getElementById(tag.htmlFor) as E;
}

const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.startsWith(text));

async function submit() {
  click(button("Create agent") ?? button("Save")!);
  await settle();
}

async function waitOutExit() {
  await act(async () => {
    vi.advanceTimersByTime(CLOSE_MS);
  });
}

describe("AgentSheet", () => {
  it("creates an agent with the trimmed name, then closes once the exit has played", async () => {
    const { onSave, onClose } = await render();
    type(control<HTMLInputElement>("Name"), "  research  ");
    type(control<HTMLTextAreaElement>("Description"), "Reads papers");
    await submit();
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      name: "research",
      provider: "claude",
      model: "",
      description: "Reads papers",
      notifications: true,
      autonomy: "ask",
    });
    await act(async () => {
      vi.advanceTimersByTime(CLOSE_MS - 1);
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("refuses to save without a name", async () => {
    const { onSave, onClose } = await render();
    type(control<HTMLInputElement>("Name"), "   ");
    await submit();
    await waitOutExit();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses another agent's name, whatever its case", async () => {
    const { onSave } = await render({ existingNames: ["Research"] });
    type(control<HTMLInputElement>("Name"), "research");
    await submit();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("starts an edit from the agent and lets it keep its own name", async () => {
    const { onSave } = await render({ session: session(), existingNames: ["research", "docs"] });
    await submit();
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      name: "research",
      provider: "claude",
      model: "claude-opus-5",
      description: "Reads papers",
      notifications: true,
      autonomy: "ask",
    });
  });

  it("saves the switches as set", async () => {
    const { onSave } = await render({ session: session() });
    click(control("Run autonomously"));
    click(control("Notifications"));
    await submit();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ autonomy: "full", notifications: false }));
  });

  it("saves the model picked in the sheet", async () => {
    const { onSave } = await render({ session: session() });
    click(button("Claude")!);
    await settle();
    click([...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.title === "Codex")!);
    click(button("GPT-5.6 Terra")!);
    await settle();
    await submit();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "codex", model: "gpt-5.6-terra" }));
  });

  it.each([
    ["⌘", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("saves on %s+Enter from anywhere", async (_, modifier) => {
    const { onSave } = await render();
    type(control<HTMLInputElement>("Name"), "docs");
    press(window, "Enter", modifier);
    await settle();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("does not save on a bare Enter", async () => {
    const { onSave } = await render();
    type(control<HTMLInputElement>("Name"), "docs");
    press(window, "Enter");
    await settle();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("stays open when the save fails, and can try again", async () => {
    let attempts = 0;
    const { onSave, onClose } = await render({
      onSave: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("daemon went away");
      },
    });
    type(control<HTMLInputElement>("Name"), "docs");
    await submit();
    await waitOutExit();
    expect(onClose).not.toHaveBeenCalled();

    await submit();
    await waitOutExit();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves once while a save is in flight", async () => {
    const saving = deferred<void>();
    const { onSave } = await render({ onSave: () => saving.promise });
    type(control<HTMLInputElement>("Name"), "docs");
    await submit();
    await submit();
    press(window, "Enter", { metaKey: true });
    expect(onSave).toHaveBeenCalledOnce();
    await act(async () => saving.resolve());
  });

  it("does not save while it is closing", async () => {
    const { onSave } = await render();
    type(control<HTMLInputElement>("Name"), "docs");
    press(window, "Escape");
    await submit();
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([
    ["Escape", () => press(window, "Escape")],
    ["the close button", () => click(document.body.querySelector('[aria-label="Close"]')!)],
    ["Cancel", () => click(button("Cancel")!)],
    ["a click outside the sheet", () => click(document.body.querySelector('[role="presentation"]')!)],
  ])("closes on %s after the exit plays", async (_, close) => {
    const { onClose, onSave } = await render();
    close();
    expect(onClose).not.toHaveBeenCalled();
    await waitOutExit();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("closes once however often it is asked", async () => {
    const { onClose } = await render();
    press(window, "Escape");
    press(window, "Escape");
    click(button("Cancel")!);
    await waitOutExit();
    await waitOutExit();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open on a click inside the sheet", async () => {
    const { onClose } = await render();
    click(document.body.querySelector("aside")!);
    await waitOutExit();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not report closed after it is gone", async () => {
    const { onClose } = await render();
    press(window, "Escape");
    view!.unmount();
    view = null;
    await waitOutExit();
    press(window, "Escape");
    await waitOutExit();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("starts a routine for the agent and closes", async () => {
    const onNewRoutine = vi.fn();
    const { onClose } = await render({ session: session(), onNewRoutine });
    click(button("New routine")!);
    expect(onNewRoutine).toHaveBeenCalledOnce();
    await waitOutExit();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("starts a new agent on the default agent", async () => {
    // The stored default lives in module state, so this sheet comes from a fresh module graph.
    // The client mock survives the reset, so `fake` still answers for it.
    vi.resetModules();
    const { AgentSheet: Fresh } = await import("./AgentSheet");
    fake.respond("agent_installed", () => ["claude", "codex"]);
    fake.respond("state_get", ({ key }) => (key === "providers:default" ? JSON.stringify({ provider: "codex", model: "gpt-5.5" }) : null));

    // The first sheet asks for the default; the next one starts from it.
    const probe = mount(<Fresh session={null} existingNames={[]} onNewRoutine={null} onSave={async () => {}} onClose={() => {}} />);
    await settle();
    probe.unmount();

    const onSave = vi.fn(async () => {});
    view = mount(<Fresh session={null} existingNames={[]} onNewRoutine={null} onSave={onSave} onClose={() => {}} />);
    await settle();
    type(control<HTMLInputElement>("Name"), "docs");
    await submit();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "codex", model: "gpt-5.5" }));
  });
});

describe("AgentSheetHost", () => {
  const sessions = [session({ id: "a1", name: "research" }), session({ id: "t1", kind: "terminal", name: "zsh" })];

  function host(editing: Session | null | undefined) {
    const sheet = {
      sheet: editing === undefined ? null : { session: editing },
      save: vi.fn(async () => {}),
      close: vi.fn(),
      newAgent: vi.fn(),
      editAgent: vi.fn(),
    } as ReturnType<typeof useAgentSheet> & { save: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    const onNewRoutine = vi.fn();
    view = mount(<AgentSheetHost sheet={sheet} sessions={sessions} onNewRoutine={onNewRoutine} />);
    return { sheet, onNewRoutine };
  }

  it("saves through the sheet, refusing agents' names but not terminals'", async () => {
    const { sheet } = host(null);
    await settle();
    type(control<HTMLInputElement>("Name"), "research");
    await submit();
    expect(sheet.save).not.toHaveBeenCalled();
    type(control<HTMLInputElement>("Name"), "zsh");
    await submit();
    expect(sheet.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "zsh" }));
  });

  it("closes through the sheet", async () => {
    const { sheet } = host(null);
    await settle();
    press(window, "Escape");
    await waitOutExit();
    expect(sheet.close).toHaveBeenCalledOnce();
  });

  it("starts a routine for the agent being edited", async () => {
    const { onNewRoutine } = host(sessions[0]!);
    await settle();
    click(button("New routine")!);
    expect(onNewRoutine).toHaveBeenCalledExactlyOnceWith("a1");
  });

  it("offers no routine while creating, and no sheet when none is open", async () => {
    host(null);
    await settle();
    expect(button("New routine")).toBeUndefined();
    view!.unmount();

    const { sheet } = host(undefined);
    await settle();
    press(window, "Escape");
    await waitOutExit();
    expect(sheet.close).not.toHaveBeenCalled();
  });
});
