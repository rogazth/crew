import type { ComponentProps, CSSProperties } from "react";
import { calloutKind, defaultTitle, iconPath } from "../../lib/markdown/callouts";

type Props = ComponentProps<"blockquote"> & {
  node?: unknown;
  "data-alert"?: string;
  "data-alert-title"?: string;
};

/**
 * A quote, or — when `remarkAlerts` found a `[!NOTE]` on it — a callout in
 * the editor's colours and icons, titled with its type or the title it named.
 */
export function Blockquote({ node: _node, children, ...rest }: Props) {
  const type = rest["data-alert"];
  if (!type) {
    return (
      <blockquote {...rest} data-streamdown="blockquote">
        {children}
      </blockquote>
    );
  }
  const kind = calloutKind(type);
  const title = rest["data-alert-title"] ?? defaultTitle(type);
  return (
    <blockquote
      {...rest}
      data-streamdown="blockquote"
      className="crew-alert"
      style={{ "--crew-alert": kind.color } as CSSProperties}
    >
      <p className="crew-alert-title">
        <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden className="size-4 shrink-0">
          <path d={iconPath(kind.icon)} />
        </svg>
        {title}
      </p>
      {children}
    </blockquote>
  );
}
