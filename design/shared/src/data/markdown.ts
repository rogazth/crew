/** Every markdown feature the transcript has to render, in one message. */
export const MARKDOWN_KITCHEN_SINK = `## The harness seam

Three providers, one transcript. The adapters translate into \`ToolDetail\` and the
renderer paints **one shape** instead of four.

### Why normalise at the seam

1. A row reads the same whether it came from Claude's \`Bash\`, Codex's \`exec_command\`
   or opencode's \`bash\`.
2. Adding a provider is a file, never an \`if\` in the UI.
3. The search index gets one schema.
   - and the FTS5 snippet marks survive
   - and \`pos\` stays stable across a resync

### Status

| Provider | Streaming | Tools | Approvals | Questions |
| --- | :---: | :---: | :---: | :---: |
| claude | ✅ | ✅ | ✅ | ✅ |
| codex | ✅ | ✅ | ⚠️ partial | ❌ |
| cursor | ✅ | ✅ | ❌ | ❌ |
| opencode | ✅ | ⚠️ names only | ❌ | ❌ |
| gemini-cli | ❌ | ❌ | ❌ | ❌ |
| aider | ❌ | ❌ | ❌ | ❌ |
| goose | ⚠️ behind a flag | ⚠️ | ❌ | ❌ |

> The table above scrolls inside its own box. A wide table must never widen the
> transcript column.
>
> > Nested quotes keep their rail.

- [x] normalise \`command\`
- [x] normalise \`file\` and \`edit\`
- [ ] normalise \`message\` across providers
- [ ] backfill \`usage\` for codex

Read \`src/lib/toolDetail.ts\` and \`crates/crew-core/src/providers/mod.rs\` together;
the second half of the mapping lives in Rust.

\`\`\`ts
export function toolLine(block: Block): ToolLine {
  const detail = detailOf(block);
  const failed = block.tool?.status === "failed";
  const title = block.tool?.title ?? block.text;
  if (!detail) return { text: title, mono: false, failed };

  switch (detail.kind) {
    case "command": {
      const failedRun = failed || (detail.exitCode !== undefined && detail.exitCode !== 0);
      return { text: firstLine(detail.command), mono: true, failed: failedRun };
    }
    case "file":
      return { text: shortPath(detail.path), mono: true, failed };
    default:
      return { text: title, mono: false, failed };
  }
}
\`\`\`

\`\`\`rust
pub fn normalise(raw: &RawTool) -> Option<ToolDetail> {
    match raw.name.to_ascii_lowercase().as_str() {
        "bash" | "shell" | "exec_command" => Some(ToolDetail::Command {
            command: raw.input.get("command")?.as_str()?.to_owned(),
            exit_code: raw.exit_code,
            output: raw.output.clone(),
        }),
        _ => None,
    }
}
\`\`\`

And the patch that fixed the \`{\` rows:

\`\`\`diff
 export function toolLine(block: Block): ToolLine {
   const detail = detailOf(block);
-  const title = block.tool?.title ?? block.text;
-  if (!detail) return { text: title, mono: false };
+  const title = block.tool?.title?.trim();
+  if (!detail) {
+    // A provider that sent no detail still owes the reader a sentence.
+    const name = block.tool?.name ?? "a tool";
+    return { text: title && title !== "{" ? title : \`Used \${name}\`, mono: false };
+  }
   switch (detail.kind) {
\`\`\`

---

Footnotes work too[^1], and so do [external links](https://base-ui.com/react/overview/quick-start).

[^1]: The daemon marks search hits with private-use characters because a snippet can
contain any text an agent produced, and \`<b>\` is text an agent produces.

~~Struck-through~~ text, *emphasis*, and a very long unbroken token to prove wrapping:
\`supercalifragilisticexpialidocious_but_as_an_identifier_that_will_not_fit\`.
`;

export const SHORT_REPLY = `Done. \`session_reorder\` now rewrites one kind at a time, so the
sidebar's manual order round-trips through the store instead of being recomputed on
load. Two tests cover it: a reorder inside a kind, and a reorder that would have
crossed kinds (rejected).`;

export const PLAN_REPLY = `Here's what I'd do, cheapest first.

1. **Give every tool row a sentence.** \`toolLine\` falls through to the provider's raw
   title today, which is how \`{\` reaches the screen. One guard fixes every provider.
2. **Give the sidebar a real busy signal.** The spinner is a 2009 affordance; a
   breathing rail or a shimmer on the row reads better at a glance and survives being
   seen out of the corner of an eye.
3. **Make agent messages a thread, not a collapsible.** They are a conversation
   between two agents; rendering them as a folded tool call loses that.

The third one is the only one that needs a design decision from you.`;
