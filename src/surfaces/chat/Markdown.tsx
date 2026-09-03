import { memo } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

type Props = { text: string; streaming?: boolean };

/** Streaming markdown, styled with Cursor's 13/18 and ink-mixed surfaces. */
export const Markdown = memo(function Markdown({ text, streaming }: Props) {
  return (
    <Streamdown className="crew-md" controls={false} isAnimating={streaming === true}>
      {text}
    </Streamdown>
  );
});
