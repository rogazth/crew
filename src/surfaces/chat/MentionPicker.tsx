import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import type { ProjectFile } from "../../lib/types";

type Props = {
  results: ProjectFile[];
  active: number;
  onHover: (index: number) => void;
  onPick: (file: ProjectFile) => void;
};

/** Sits above the well while an `@` is being typed. The keyboard lives in the composer. */
export function MentionPicker({ results, active, onHover, onPick }: Props) {
  return (
    <div role="listbox" aria-label="Files" className="crew-popover absolute inset-x-0 bottom-full z-20 mb-2">
      {results.length === 0 ? (
        <p className="px-3 py-2 text-[12px] leading-4 text-text-muted">No matching files</p>
      ) : (
        results.map((file, index) => {
          const dir = file.relative.slice(0, -file.name.length);
          return (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(file)}
              className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] ${
                index === active ? "bg-hover" : ""
              }`}
            >
              <FileTypeIcon name={file.name} className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                <span>{file.name}</span>
                {dir && <span className="ml-2 text-text-muted">{dir.replace(/\/$/, "")}</span>}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
