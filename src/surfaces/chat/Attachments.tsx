import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { useImageSrc } from "../../hooks/useImageSrc";
import type { Upload } from "../../hooks/useUploads";
import { formatBytes, isImage } from "../../lib/attachments";
import type { AttachedFile } from "../../lib/blocks";
import { useChatActions } from "./context";

type Props = {
  files: AttachedFile[];
  onRemove?: (path: string) => void;
  /** Files still travelling to another machine, in the composer only. */
  uploads?: Upload[];
  onDismissUpload?: (id: number) => void;
  /** Inside the ink bubble chips are a lighter ink, not a darker card. */
  onInk?: boolean;
  /** The user's own message: every file a small square at the bubble's side, an image cropped, anything else its type's icon. */
  tiles?: boolean;
};

/** Which ends of the composer's scrolling strip have more past them; the stylesheet fades those. */
function useScrollFade(active: boolean, count: number) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current;
    if (!el || !active) return;
    const read = () => {
      el.toggleAttribute("data-fade-start", el.scrollLeft > 1);
      el.toggleAttribute("data-fade-end", el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      watch.disconnect();
    };
  }, [active, count]);
  return strip;
}

/** What every file's pill shares, whatever it is and however far it has travelled. */
const PILL = "inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-full px-2.5 text-[12px] leading-4 shadow-[inset_0_0_0_1px_var(--color-hairline)]";

/**
 * One strip for the composer and the sent turn. In the composer every file is
 * the same pill, in one row that scrolls. In your own message every file is a
 * small square: an image cropped, anything else its type's icon and its name.
 * An image a tool showed is drawn at size. Every one of them opens: an image
 * in the viewer, anything else in a tab.
 */
export function AttachmentStrip({ files, onRemove, onInk, tiles = false, uploads = [], onDismissUpload }: Props) {
  const images = files.filter(isImage);
  const others = files.filter((file) => !isImage(file));
  const [open, setOpen] = useState<number | null>(null);
  const { openPath } = useChatActions();
  const inComposer = onRemove !== undefined;
  const strip = useScrollFade(inComposer, files.length + uploads.length);
  if (files.length === 0 && uploads.length === 0) return null;
  return (
    <div ref={strip} {...(inComposer ? { "data-composer-strip": "" } : {})} className={`flex flex-wrap items-center gap-2 ${tiles ? "justify-end" : ""}`}>
      {tiles
        ? files.map((file) =>
            isImage(file) ? (
              <Tile key={file.path} file={file} onOpen={() => setOpen(images.indexOf(file))} />
            ) : (
              <FileTile key={file.path} file={file} onOpen={() => openPath(file.path)} />
            ),
          )
        : inComposer
        ? files.map((file) => (
            <FilePill
              key={file.path}
              file={file}
              {...(onRemove ? { onRemove: () => onRemove(file.path) } : {})}
              onOpen={() => (isImage(file) ? setOpen(images.indexOf(file)) : openPath(file.path))}
            />
          ))
        : [
            ...images.map((file, index) => <Thumbnail key={file.path} file={file} onOpen={() => setOpen(index)} />),
            ...others.map((file) => <FilePill key={file.path} file={file} onOpen={() => openPath(file.path)} onInk={onInk === true} />),
          ]}
      {uploads.map((upload) => (
        <UploadPill key={upload.id} upload={upload} {...(onDismissUpload ? { onDismiss: () => onDismissUpload(upload.id) } : {})} />
      ))}
      {open !== null && images.length > 0 && (
        <Lightbox images={images} index={Math.min(open, images.length - 1)} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

const TILE =
  "size-[72px] shrink-0 overflow-hidden rounded-xl bg-card shadow-[inset_0_0_0_1px_var(--color-hairline)] focus-visible:ring-[1.5px] focus-visible:ring-focus/50 focus-visible:outline-none";

/** An image in the user's own message: a small square, cropped. */
function Tile({ file, onOpen }: { file: AttachedFile; onOpen: () => void }) {
  const src = useImageSrc(file.path);
  return (
    <button type="button" onClick={onOpen} title={file.name} aria-label={`Open ${file.name}`} className={TILE}>
      {src && <img src={src} alt={file.name} className="size-full object-cover" />}
    </button>
  );
}

/** Any other file in the user's own message: the same square, its type's icon and its name. */
function FileTile({ file, onOpen }: { file: AttachedFile; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={file.path}
      aria-label={`Open ${file.name}`}
      data-file-chip
      className={`${TILE} flex flex-col items-center justify-center gap-1.5 px-1.5 transition-colors hover:bg-selected`}
    >
      <FileTypeIcon name={file.name} className="size-6" />
      <span className="w-full truncate text-center text-[10.5px] leading-3 text-text-muted">{file.name}</span>
    </button>
  );
}

/**
 * An image a tool showed, in a box of one size whether it has loaded or not:
 * the image arrives a tick after the row mounts, and a box that changed size
 * then would move everything under it, and cut short a panel opening onto it.
 */
function Thumbnail({ file, onOpen }: { file: AttachedFile; onOpen: () => void }) {
  const src = useImageSrc(file.path);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={file.name}
      aria-label={`Open ${file.name}`}
      className="inline-flex h-40 w-60 shrink-0 overflow-hidden rounded-lg bg-card focus-visible:ring-[1.5px] focus-visible:ring-focus/50 focus-visible:outline-none"
    >
      {src ? <img src={src} alt={file.name} className="block size-full object-contain" /> : null}
    </button>
  );
}

function RemoveX({ label, title, onClick }: { label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className="-mr-1 flex size-4 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text"
    >
      <XIcon className="size-3" />
    </button>
  );
}

/** A file on its way to a remote machine: how far it is, or why it stopped. The X cancels it, or clears it once failed. */
function UploadPill({ upload, onDismiss }: { upload: Upload; onDismiss?: () => void }) {
  const failed = upload.error !== undefined;
  const percent = upload.size > 0 ? Math.min(100, Math.round((upload.sent / upload.size) * 100)) : 0;
  return (
    <span title={failed ? upload.error : `${upload.name}: ${formatBytes(upload.sent)} of ${formatBytes(upload.size)}`} className={`${PILL} relative overflow-hidden bg-card`}>
      <FileTypeIcon name={upload.name} className="size-3.5" />
      <span className="min-w-0 truncate">{upload.name}</span>
      <span className={`shrink-0 tabular-nums ${failed ? "text-danger" : "opacity-60"}`}>{failed ? "Failed" : `${percent}%`}</span>
      {onDismiss && <RemoveX label={`${failed ? "Dismiss" : "Cancel upload of"} ${upload.name}`} title={failed ? "Dismiss" : "Cancel upload"} onClick={onDismiss} />}
      {!failed && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-hairline">
          <span className="block h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
        </span>
      )}
    </span>
  );
}

function FilePill({ file, onOpen, onRemove, onInk }: { file: AttachedFile; onOpen: () => void; onRemove?: () => void; onInk?: boolean }) {
  return (
    <span title={file.path} data-file-chip className={`${PILL} ${onInk ? "crew-chip-on-ink" : "bg-card"}`}>
      <button type="button" onClick={onOpen} aria-label={`Open ${file.name}`} className="flex min-w-0 items-center gap-1.5 outline-none focus-visible:underline">
        <FileTypeIcon name={file.name} className="size-3.5" />
        <span className="min-w-0 truncate">{file.name}</span>
        {file.size !== undefined && <span className="shrink-0 opacity-60">{formatBytes(file.size)}</span>}
      </button>
      {onRemove && <RemoveX label={`Remove ${file.name}`} onClick={onRemove} />}
    </span>
  );
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.5;
/** How far an arrow key moves a zoomed image. */
const PAN_PX = 80;

type View = { scale: number; x: number; y: number };

/** Where a pointer is, from the viewport's centre: the image's own centre at rest. */
function fromCentre(event: { clientX: number; clientY: number }) {
  return { x: event.clientX - innerWidth / 2, y: event.clientY - innerHeight / 2 };
}
const AT_REST: View = { scale: 1, x: 0, y: 0 };

/** The view zoomed to `scale`, keeping the point `at` (from the viewport's centre) where it is on screen. */
function zoomTo(view: View, scale: number, at = { x: 0, y: 0 }): View {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
  if (next === MIN_ZOOM) return AT_REST;
  const k = next / view.scale;
  return { scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k };
}

/**
 * The image at rest, on a dim scrim, held back from the edges. It zooms with
 * the buttons, + and −, a pinch or ⌘ and the wheel, or a double click where
 * it lands; zoomed in, it drags and the arrows move it. Otherwise the arrows
 * walk the strip. 0 puts it back, Escape and the scrim close.
 */
export function Lightbox({
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
  const loaded = useImageSrc(file.path);
  // Moving to another image keeps the last one up until the next has loaded: the switch is a cut, never a blank.
  const [held, setHeld] = useState<string | null>(null);
  if (loaded && loaded !== held) setHeld(loaded);
  const src = loaded ?? held;
  // Opened a beat after it mounts, so it fades in; closing lets it fade out before the caller drops it.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const close = () => setOpen(false);
  const many = images.length > 1;
  const [view, setView] = useState<View>(AT_REST);
  // Another image starts whole.
  const [shown, setShown] = useState(index);
  if (shown !== index) {
    setShown(index);
    setView(AT_REST);
  }
  const zoomed = view.scale > MIN_ZOOM;
  const drag = useRef<{ x: number; y: number; from: View; moved: boolean } | null>(null);
  // While the hand moves it, the image follows at once instead of easing after it.
  const [dragging, setDragging] = useState(false);
  // The keys are the viewer's, not the first button's: Enter would reset the zoom.
  const popup = useRef<HTMLDivElement>(null);
  const prev = () => onIndex((index - 1 + images.length) % images.length);
  const next = () => onIndex((index + 1) % images.length);
  const zoomBy = (factor: number) => setView((v) => zoomTo(v, v.scale * factor));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const pan = { ArrowLeft: [PAN_PX, 0], ArrowRight: [-PAN_PX, 0], ArrowUp: [0, PAN_PX], ArrowDown: [0, -PAN_PX] }[event.key];
      if (pan && zoomed) {
        event.preventDefault();
        setView((v) => ({ ...v, x: v.x + pan[0]!, y: v.y + pan[1]! }));
      } else if (event.key === "ArrowLeft" && many) prev();
      else if (event.key === "ArrowRight" && many) next();
      else if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
      else if (event.key === "-" || event.key === "_") zoomBy(1 / ZOOM_STEP);
      else if (event.key === "0") setView(AT_REST);
      else return;
      event.preventDefault();
    };
    // Captured: the popup stops arrow keys from bubbling past itself.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  const onWheel = (event: React.WheelEvent) => {
    // A trackpad pinch arrives as a wheel with ctrl held; ⌘ and the wheel zooms too.
    if (event.ctrlKey || event.metaKey) {
      const at = fromCentre(event);
      // A pinch sends small steps; a mouse wheel sends big ones, held to one notch's worth.
      const step = Math.max(-40, Math.min(40, event.deltaY));
      setView((v) => zoomTo(v, v.scale * Math.exp(-step / 100), at));
    } else if (zoomed) {
      setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()} onOpenChangeComplete={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="crew-lightbox-scrim" />
        <Dialog.Popup
          ref={popup}
          initialFocus={popup}
          className="crew-lightbox"
          aria-label={file.name}
          onWheel={onWheel}
          // The popup fills the viewport above the scrim, so the empty space around the image is the outside.
          onClick={(event) => event.target === event.currentTarget && !drag.current?.moved && close()}
        >
          {src ? (
            <img
              src={src}
              alt={file.name}
              draggable={false}
              data-zoomed={zoomed || undefined}
              data-dragging={dragging || undefined}
              className="crew-lightbox-image"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              onDoubleClick={(event) => {
                const at = fromCentre(event);
                setView((v) => (v.scale > MIN_ZOOM ? AT_REST : zoomTo(v, 2.5, at)));
              }}
              onPointerDown={(event) => {
                // The second press of a double click is the double click's.
                if (!zoomed || event.button !== 0 || event.detail > 1) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { x: event.clientX, y: event.clientY, from: view, moved: false };
              }}
              onPointerMove={(event) => {
                const start = drag.current;
                if (!start) return;
                const dx = event.clientX - start.x;
                const dy = event.clientY - start.y;
                if (!start.moved && Math.abs(dx) + Math.abs(dy) <= 3) return;
                start.moved = true;
                setDragging(true);
                setView({ ...start.from, x: start.from.x + dx, y: start.from.y + dy });
              }}
              onPointerUp={() => {
                setDragging(false);
                // The click that ends a drag is not one on the scrim.
                setTimeout(() => (drag.current = null));
              }}
              onPointerCancel={() => {
                setDragging(false);
                drag.current = null;
              }}
            />
          ) : null}
          <div className="crew-lightbox-bar">
            <span className="min-w-0 truncate">{file.name}</span>
            {many && (
              <span className="tabular-nums">
                {index + 1} / {images.length}
              </span>
            )}
            <span className="crew-lightbox-zoom">
              <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={!zoomed} onClick={() => zoomBy(1 / ZOOM_STEP)}>
                <MinusIcon className="size-3.5" />
              </button>
              <button type="button" aria-label="Actual size" title="Fit (0)" onClick={() => setView(AT_REST)} className="tabular-nums">
                {Math.round(view.scale * 100)}%
              </button>
              <button type="button" aria-label="Zoom in" title="Zoom in (+)" disabled={view.scale >= MAX_ZOOM} onClick={() => zoomBy(ZOOM_STEP)}>
                <PlusIcon className="size-3.5" />
              </button>
            </span>
          </div>
          {many && (
            <>
              <button type="button" aria-label="Previous" onClick={prev} className="crew-lightbox-nav left-3">
                <ChevronLeftIcon className="size-4" />
              </button>
              <button type="button" aria-label="Next" onClick={next} className="crew-lightbox-nav right-3">
                <ChevronRightIcon className="size-4" />
              </button>
            </>
          )}
          <Dialog.Close aria-label="Close" className="crew-lightbox-close">
            <XIcon className="size-4" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
