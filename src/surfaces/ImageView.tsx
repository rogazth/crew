import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowClockwiseIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@phosphor-icons/react";
import { useCommands } from "../hooks/useCommand";
import { previewRoot } from "../lib/browser/files";
import { commandKeys } from "../lib/commands";
import { fitScale, GUTTER, MAX_SCALE, MIN_SCALE, stepScale, type Size } from "../lib/imageZoom";
import { filesHost } from "../lib/host";

const HEADER_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-kumo-subtle hover:bg-hover hover:text-kumo-default disabled:opacity-40";

/**
 * An image file on a checkerboard, fitted to the pane until zoomed. A click
 * toggles fit and actual size; ⌘= and ⌘- step, ⌘0 is actual size, and a pinch
 * or ⌘-scroll zooms. Served the way previews are, so any size loads without
 * travelling through the daemon.
 */
export function ImageView({ path, relative, actions }: { path: string; relative: string; actions?: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [pane, setPane] = useState<Size>({ width: 0, height: 0 });
  /** null is fitted to the pane. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = filesHost();
    if (!host) return;
    let gone = false;
    host
      .url(previewRoot(path, relative), path)
      .then((next) => {
        if (gone) return;
        if (next) setUrl(next);
        else setProblem("This image can't be shown.");
      })
      .catch((error: unknown) => !gone && setProblem(String(error)));
    return () => {
      gone = true;
    };
  }, [path, relative]);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setPane({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = natural ? fitScale(natural, pane) : 1;
  const scale = zoom ?? fit;
  const step = (direction: 1 | -1) => setZoom(stepScale(scale, direction));
  const reload = () => {
    setProblem(null);
    setVersion((n) => n + 1);
  };

  useCommands({
    "zoom-in": () => step(1),
    "zoom-out": () => step(-1),
    "zoom-reset": () => setZoom(1),
    "browser-reload": reload,
  });

  // Pinches arrive as ctrl+wheel; React's wheel listener is passive, so this one is bound by hand.
  const latest = useRef(scale);
  useEffect(() => {
    latest.current = scale;
  });
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const next = latest.current * Math.exp(-event.deltaY / 100);
      setZoom(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const failure = filesHost() ? problem : "Images need the desktop app.";
  const shown = natural && { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) };
  const percent = `${Math.round(scale * 100)}%`;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-text-muted">
        <span className="truncate">{relative}</span>
        {natural && (
          <span className="shrink-0 text-[12px] text-placeholder tabular-nums">
            {natural.width} × {natural.height}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Zoom Out"
            title={`Zoom Out (${commandKeys("zoom-out")})`}
            disabled={!natural || scale <= MIN_SCALE}
            onClick={() => step(-1)}
            className={HEADER_BUTTON}
          >
            <MagnifyingGlassMinusIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label={zoom === null ? "Show at actual size" : "Fit to window"}
            title={zoom === null ? `Actual Size (${commandKeys("zoom-reset")})` : "Fit to Window"}
            disabled={!natural}
            onClick={() => setZoom(zoom === null ? 1 : null)}
            className="h-7 min-w-12 shrink-0 rounded-md px-1.5 text-[12px] text-kumo-subtle tabular-nums hover:bg-hover hover:text-kumo-default"
          >
            {zoom === null ? `Fit · ${percent}` : percent}
          </button>
          <button
            type="button"
            aria-label="Zoom In"
            title={`Zoom In (${commandKeys("zoom-in")})`}
            disabled={!natural || scale >= MAX_SCALE}
            onClick={() => step(1)}
            className={HEADER_BUTTON}
          >
            <MagnifyingGlassPlusIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Reload"
            title={`Reload (${commandKeys("browser-reload")})`}
            onClick={reload}
            className={HEADER_BUTTON}
          >
            <ArrowClockwiseIcon className="size-4" />
          </button>
          {actions}
        </span>
      </div>
      {/* Auto margins centre the image while it fits and fall to zero once it doesn't, so it scrolls from its corner. */}
      <div ref={box} className="relative grid min-h-0 flex-1 overflow-auto bg-sidebar" style={{ padding: GUTTER }}>
        {url && !failure && (
          <img
            key={version}
            src={version ? `${url}?v=${version}` : url}
            alt={relative}
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget;
              setNatural({ width: image.naturalWidth, height: image.naturalHeight });
            }}
            onError={() => setProblem("This image didn't load. It may be damaged, or in a format Chromium can't read.")}
            onClick={() => setZoom(zoom === null ? 1 : null)}
            style={
              shown
                ? {
                    width: shown.width,
                    height: shown.height,
                    maxWidth: "none",
                    margin: "auto",
                    // Enlarged pixels stay square, so an icon's edges read at 800%.
                    imageRendering: scale >= 2 ? "pixelated" : "auto",
                  }
                : { visibility: "hidden" }
            }
            className={`crew-checkerboard ${zoom === null ? "cursor-zoom-in" : "cursor-zoom-out"}`}
          />
        )}
        {failure && <p className="m-auto max-w-sm px-6 text-center text-text-muted">{failure}</p>}
      </div>
    </div>
  );
}
