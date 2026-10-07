import { describe, expect, it } from "vitest";
import {
  AGAIN_MS,
  ANSWER_STEP_MS,
  approvalKeys,
  ENTER_AFTER_MS,
  messageKeys,
  PASTE_PIECE,
  PATH_SETTLE_MS,
  PtyQueue,
  questionKeys,
  SLASH_KEY_MS,
  stopKeys,
  trustKeys,
  type SendClock,
} from "./ptySend";
import type { Question } from "./protocol";

/** A clock that only moves when the test says so. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let next = 0;
  const clock: SendClock = {
    setTimeout: (run, ms) => {
      const id = next++;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clearTimeout: (id) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await flush();
      const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.run();
    }
    now = until;
    await flush();
  };
  return { clock, advance, now: () => now };
}

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function recorder(time: () => number) {
  const writes: { data: string; at: number }[] = [];
  const write = (data: string) => {
    writes.push({ data, at: time() });
    return Promise.resolve();
  };
  return { writes, write };
}

describe("messageKeys", () => {
  it("clears the line, pastes the text, and sends Enter on its own later", () => {
    expect(messageKeys("claude", "fix hello.txt")).toEqual([
      { data: "\x15", wait: 0 },
      { data: "\x1b[200~fix hello.txt\x1b[201~", wait: 0 },
      { data: "\r", wait: ENTER_AFTER_MS },
    ]);
  });

  it("pastes a message of several lines whole, so its newlines do not send it", () => {
    const keys = messageKeys("codex", "one\ntwo");
    expect(keys[1]?.data).toBe("\x1b[200~one\ntwo\x1b[201~");
    expect(keys.at(-1)).toEqual({ data: "\r", wait: ENTER_AFTER_MS });
  });

  it("pastes Claude's lines one by one with ⌃J between, so none is taken as pasted text", () => {
    const keys = messageKeys("claude", "one\r\n\nthree");
    expect(keys[1]?.data).toBe("\x1b[200~one\x1b[201~\n\n\x1b[200~three\x1b[201~");
    expect(keys.at(-1)).toEqual({ data: "\r", wait: ENTER_AFTER_MS });
  });

  it("pastes a long line to Claude in pieces short enough not to collapse", () => {
    const line = "a".repeat(PASTE_PIECE) + "é".repeat(PASTE_PIECE) + "z";
    expect(messageKeys("claude", line)[1]?.data).toBe(
      ["a".repeat(PASTE_PIECE), "é".repeat(PASTE_PIECE), "z"].map((piece) => `\x1b[200~${piece}\x1b[201~`).join(""),
    );
  });

  it("pastes each attachment as its path, and lets them settle before the text", () => {
    const keys = messageKeys("claude", "what is this?", ["/tmp/shot one.png", "/tmp/b.txt"]);
    expect(keys.map((key) => key.data)).toEqual([
      "\x15",
      "\x1b[200~'/tmp/shot one.png' \x1b[201~",
      "\x1b[200~/tmp/b.txt \x1b[201~",
      "\x1b[200~what is this?\x1b[201~",
      "\r",
    ]);
    expect(keys[3]?.wait).toBe(PATH_SETTLE_MS);
  });

  it("types a Codex slash command a key at a time", () => {
    const keys = messageKeys("codex", "/model");
    expect(keys.slice(1, -1)).toEqual([..."/model"].map((data, at) => ({ data, wait: at === 0 ? 0 : SLASH_KEY_MS })));
    // Claude takes a pasted command as it is.
    expect(messageKeys("claude", "/model")[1]?.data).toBe("\x1b[200~/model\x1b[201~");
  });
});

describe("PtyQueue", () => {
  it("writes the keys in order, Enter as a separate write after its pause", async () => {
    const { clock, advance, now } = fakeClock();
    const { writes, write } = recorder(now);
    const queue = new PtyQueue(write, clock);
    const sending = queue.send(messageKeys("claude", "hi"));
    await advance(ENTER_AFTER_MS - 1);
    expect(writes.map((w) => w.data)).toEqual(["\x15", "\x1b[200~hi\x1b[201~"]);
    await advance(1);
    expect(writes).toEqual([
      { data: "\x15", at: 0 },
      { data: "\x1b[200~hi\x1b[201~", at: 0 },
      { data: "\r", at: ENTER_AFTER_MS },
    ]);
    expect(await sending.done).toBe(true);
  });

  it("holds the next send until the one before has pressed Enter", async () => {
    const { clock, advance, now } = fakeClock();
    const { writes, write } = recorder(now);
    const queue = new PtyQueue(write, clock);
    queue.send(messageKeys("claude", "first"));
    queue.send(messageKeys("claude", "second"));
    await advance(ENTER_AFTER_MS * 3);
    expect(writes.map((w) => w.data)).toEqual(["\x15", paste("first"), "\r", "\x15", paste("second"), "\r"]);
    expect(writes[3]?.at).toBe(ENTER_AFTER_MS);
  });

  it("clears the line again when a send is cancelled after its text landed", async () => {
    const { clock, advance, now } = fakeClock();
    const { writes, write } = recorder(now);
    const queue = new PtyQueue(write, clock);
    const sending = queue.send(messageKeys("claude", "never mind"));
    await advance(100);
    sending.cancel();
    expect(await sending.done).toBe(false);
    await advance(ENTER_AFTER_MS);
    expect(writes.map((w) => w.data)).toEqual(["\x15", paste("never mind"), "\x15"]);
  });

  it("writes nothing for a send cancelled while it waited its turn", async () => {
    const { clock, advance, now } = fakeClock();
    const { writes, write } = recorder(now);
    const queue = new PtyQueue(write, clock);
    queue.send(messageKeys("claude", "first"));
    const second = queue.send(messageKeys("claude", "second"));
    second.cancel();
    await advance(ENTER_AFTER_MS * 3);
    expect(writes.map((w) => w.data)).toEqual(["\x15", paste("first"), "\r"]);
    expect(await second.done).toBe(false);
  });

  it("keeps going after a send whose write failed", async () => {
    const { clock, advance } = fakeClock();
    const writes: string[] = [];
    let fail = true;
    const queue = new PtyQueue((data) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("gone"));
      }
      writes.push(data);
      return Promise.resolve();
    }, clock);
    const first = queue.send(messageKeys("claude", "a"));
    queue.send(messageKeys("claude", "b"));
    await advance(ENTER_AFTER_MS * 2);
    expect(await first.done).toBe(false);
    expect(writes).toEqual(["\x15", paste("b"), "\r"]);
  });
});

const color: Question = {
  question: "What is your favorite color?",
  header: "Color",
  multiSelect: false,
  options: [{ label: "Red" }, { label: "Blue" }],
};
const fruit: Question = {
  question: "What is your favorite fruit?",
  header: "Fruit",
  multiSelect: false,
  options: [{ label: "Apple" }, { label: "Pear" }],
};
const toppings: Question = {
  question: "Which toppings?",
  header: "Toppings",
  multiSelect: true,
  options: [{ label: "cheese" }, { label: "ham" }, { label: "olives" }],
};

const keysOf = (questions: Question[], answers: Record<string, string> | null) =>
  questionKeys(questions, answers).map((key) => key.data);

describe("answer keys", () => {
  it("approves Claude with 1, always with 2, and denies with Esc", () => {
    expect(approvalKeys("claude", "allow")[0]?.data).toBe("1");
    expect(approvalKeys("claude", "always")[0]?.data).toBe("2");
    expect(approvalKeys("claude", "deny")[0]?.data).toBe("\x1b");
  });

  it("approves Codex with y, for the session with a, and denies with Esc", () => {
    expect(approvalKeys("codex", "allow")[0]?.data).toBe("y");
    expect(approvalKeys("codex", "always")[0]?.data).toBe("a");
    expect(approvalKeys("codex", "deny")[0]?.data).toBe("\x1b");
  });

  it("trusts a folder by moving off Claude's default before Enter, or with Cursor's key, and declines", () => {
    expect(trustKeys("claude", true).map((key) => key.data)).toEqual(["\x1b[B", "\r"]);
    expect(trustKeys("claude", false).map((key) => key.data)).toEqual(["\x1b"]);
    expect(trustKeys("cursor", true).map((key) => key.data)).toEqual(["a"]);
    expect(trustKeys("cursor", false).map((key) => key.data)).toEqual(["q"]);
  });

  it("picks one option with its digit, which also submits a lone question", () => {
    expect(keysOf([color], { [color.question]: "Blue" })).toEqual(["2"]);
  });

  it("walks several questions and submits from the review screen", () => {
    const keys = questionKeys([color, fruit], { [color.question]: "Blue", [fruit.question]: "Apple" });
    expect(keys.map((key) => key.data)).toEqual(["2", "1", "1"]);
    expect(keys.map((key) => key.wait)).toEqual([0, ANSWER_STEP_MS, ANSWER_STEP_MS]);
  });

  it("types an answer of its own on the row after the options", () => {
    expect(keysOf([color], { [color.question]: "a parrot named Kiwi" })).toEqual(["3", "a parrot named Kiwi", "\r"]);
  });

  it("toggles each pick of a multi-select, moves on with →, and submits", () => {
    expect(keysOf([toppings], { [toppings.question]: "cheese, olives" })).toEqual(["1", "3", "\x1b[C", "1"]);
    expect(
      keysOf([toppings, fruit], { [toppings.question]: "ham", [fruit.question]: "medium please" }),
    ).toEqual(["2", "\x1b[C", "3", "medium please", "\r", "1"]);
  });

  it("stops with Esc, pressed twice for opencode", () => {
    expect(stopKeys("claude").map((key) => key.data)).toEqual(["\x1b"]);
    expect(stopKeys("opencode")).toEqual([
      { data: "\x1b", wait: 0 },
      { data: "\x1b", wait: AGAIN_MS },
    ]);
  });

  it("dismisses the form with Esc", () => {
    expect(keysOf([color], null)).toEqual(["\x1b"]);
  });
});
