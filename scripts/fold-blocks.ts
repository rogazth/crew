import { applyEvent, type Block, type HarnessEvent } from "../src/lib/blocks.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  start?: Block[];
  events: HarnessEvent[];
};
const blocks = input.events.reduce(applyEvent, input.start ?? []);
process.stdout.write(JSON.stringify(blocks));
