import { memo, type ReactNode } from "react";
import { agentLabel } from "../../lib/agentNames";
import type { Block } from "../../lib/blocks";
import type { ToolDetail } from "../../lib/protocol";
import { detailOf, langProp } from "../../lib/toolDetail";
import { CommandBody, EditBody, FetchBody, Pair, Pre, Prose, Result, Source, Todos } from "./ToolParts";

type Kind = ToolDetail["kind"];
type Render<K extends Kind> = (detail: Extract<ToolDetail, { kind: K }>, failed: boolean) => ReactNode;

/** One renderer per kind; the type makes a new kind a compile error until it has one. */
const BODIES: { [K in Kind]: Render<K> } = {
  command: (detail, failed) => <CommandBody detail={detail} failed={failed} />,
  file: (detail) => (detail.preview?.trim() ? <Source text={detail.preview} {...langProp(detail.path)} /> : null),
  edit: (detail) => <EditBody detail={detail} />,
  search: (detail, failed) => (detail.output ? <Result head="results" text={detail.output} danger={failed} /> : null),
  fetch: (detail, failed) => (detail.output ? <FetchBody text={detail.output} failed={failed} /> : null),
  message: (detail) => <Pre head={`to ${agentLabel(detail.to)}`} text={detail.text} />,
  todo: (detail) => <Todos items={detail.items} />,
  agent: (detail) => (
    <Pair
      first={detail.prompt ? <Pre head="asked" text={detail.prompt} /> : null}
      second={detail.output ? <Prose text={detail.output} /> : null}
    />
  ),
  mcp: (detail, failed) => (
    <Pair
      first={detail.input ? <Source text={detail.input} lang="json" /> : null}
      second={detail.output ? <Result head="result" text={detail.output} danger={failed} /> : null}
    />
  ),
  plan: (detail) => <Prose text={detail.text} />,
  output: (detail, failed) => <Result head="output" text={detail.text} danger={failed} />,
};

/**
 * What the row shows when it is opened. Only the kinds that carry something
 * worth a box get one; `hasBody` in `lib/toolDetail` is the same decision, made
 * before the row offers to open at all.
 */
export const ToolBody = memo(function ToolBody({ block }: { block: Block }) {
  const detail = detailOf(block);
  if (!detail) return null;
  const render = BODIES[detail.kind] as Render<Kind>;
  return render(detail, block.tool?.status === "failed");
});
