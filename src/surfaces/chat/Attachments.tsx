import { Dialog } from "@base-ui/react/dialog";
import { CaretLeftIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { X } from "../../chrome/icons";
import { useImageSrc } from "../../hooks/useImageSrc";
import { formatBytes, isImage } from "../../lib/attachments";
import type { AttachedFile } from "../../lib/blocks";

type Props = {
  files: AttachedFile[];
  onRemove?: (path: string) => void;
  /** Inside the ink bubble chips are a lighter ink, not a darker card. */
  onInk?: boolean;
};

/** Images as thumbnails that open a viewer; other files as chips. One strip for the composer and the sent turn. */
export function AttachmentStrip({ files, onRemove, onInk }: Props) {
  const images = files.filter(isImage);
  const others = files.filter((file) => !isImage(file));
  const [open, setOpen] = useState<number | null>(null);
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((file, index) => (
        <Thumbnail
          key={file.path}
          file={file}
          size={onRemove ? "chip" : "tile"}
          onOpen={() => setOpen(index)}
          {...(onRemove ? { onRemove: () => onRemove(file.path) } : {})}
        />
      ))}
      {others.map((file) => (
        <FileChip key={file.path} file={file} onInk={onInk === true} {...(onRemove ? { onRemove: () => onRemove(file.path) } : {})} />
      ))}
      {open !== null && images.length > 0 && (
        <Lightbox images={images} index={Math.min(open, images.length - 1)} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

function Thumbnail({
  file,
  size,
  onOpen,
  onRemove,
}: {
  file: AttachedFile;
  size: "chip" | "tile";
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const src = useImageSrc(file.path);
  const box = size === "chip" ? "size-12" : "max-h-40 max-w-[240px]";
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onOpen}
        title={file.name}
        aria-label={`Open ${file.name}`}
        className={`overflow-hidden rounded-lg bg-card focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50 focus-visible:outline-none ${box}`}
      >
        {src ? (
          <img src={src} alt={file.name} className={size === "chip" ? "size-full object-cover" : "block max-h-40 max-w-[240px] object-contain"} />
        ) : (
          <span className={`block ${size === "chip" ? "size-12" : "h-24 w-32"}`} />
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-text text-canvas opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
}

function FileChip({ file, onRemove, onInk }: { file: AttachedFile; onRemove?: () => void; onInk?: boolean }) {
  return (
    <span
      title={file.path}
      className={`inline-flex h-6 max-w-[200px] items-center gap-1.5 rounded-md px-2 text-[12px] leading-4 ${onInk ? "crew-chip-on-ink" : "bg-card"}`}
    >
      <FileTypeIcon name={file.name} className="size-3.5" />
      <span className="min-w-0 truncate">{file.name}</span>
      {file.size !== undefined && <span className="shrink-0 opacity-60">{formatBytes(file.size)}</span>}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          onClick={onRemove}
          className="-mr-0.5 flex size-4 items-center justify-center rounded text-kumo-subtle transition-colors hover:text-text"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

/** The image at rest, on a dim scrim. Arrows walk the strip, Escape and the scrim close. */
function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: AttachedFile[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const file = images[index]!;
  const src = useImageSrc(file.path);
  const many = images.length > 1;
  const prev = () => onIndex((index - 1 + images.length) % images.length);
  const next = () => onIndex((index + 1) % images.length);

  useEffect(() => {
    if (!many) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") prev();
      if (event.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="crew-lightbox-scrim" />
        <Dialog.Popup className="crew-lightbox" aria-label={file.name}>
          {src ? <img src={src} alt={file.name} className="crew-lightbox-image" /> : null}
          <div className="crew-lightbox-bar">
            <span className="min-w-0 truncate">{file.name}</span>
            {many && (
              <span className="tabular-nums">
                {index + 1} / {images.length}
              </span>
            )}
          </div>
          {many && (
            <>
              <button type="button" aria-label="Previous" onClick={prev} className="crew-lightbox-nav left-3">
                <CaretLeftIcon className="size-4" weight="bold" />
              </button>
              <button type="button" aria-label="Next" onClick={next} className="crew-lightbox-nav right-3">
                <CaretRightIcon className="size-4" weight="bold" />
              </button>
            </>
          )}
          <Dialog.Close aria-label="Close" className="crew-lightbox-close">
            <XIcon className="size-4" weight="bold" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
