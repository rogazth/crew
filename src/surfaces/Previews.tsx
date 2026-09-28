import { lazy, Suspense, useState } from "react";
import { useBrowserPrefs } from "../hooks/useBrowserPrefs";
import { fileView } from "../lib/browser/files";
import { liveGuests, touch } from "../lib/browser/retention";
import type { MountedPane } from "./WorkspacePanes";

/** The preview lives with the file editors' chunk; only a media tab pays for it. */
const FilePreview = lazy(() => import("./FileView").then((m) => ({ default: m.FilePreview })));

type FileTab = Extract<MountedPane["tab"], { kind: "file" }>;
type PreviewMount = MountedPane & { tab: FileTab };

const isPreview = (pane: MountedPane): pane is PreviewMount =>
  pane.tab.kind === "file" && fileView(pane.tab.relative) === "media";

/**
 * A PDF, video or audio tab stays mounted while hidden, like a page: its guest
 * leaving the DOM loses the file, the page it was on and where it was playing.
 * Only the most recently shown ones keep their guest, as pages do.
 */
export function Previews({ panes }: { panes: MountedPane[] }) {
  const { prefs } = useBrowserPrefs();
  const previews = panes.filter(isPreview);
  const visibleId = previews.find((pane) => pane.visible)?.id ?? null;

  const [order, setOrder] = useState<readonly string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  if (shown !== visibleId) {
    setShown(visibleId);
    if (visibleId) setOrder((current) => touch(current, visibleId));
  }
  const ids = new Set(previews.map((pane) => pane.id));
  const live = liveGuests({
    order: order.filter((id) => ids.has(id)),
    visible: visibleId,
    keep: prefs.keep,
    pinned: new Set(),
  });

  return previews.map((pane) => (
    <div key={pane.id} hidden={!pane.visible} className="absolute inset-0">
      {live.has(pane.id) && (
        <Suspense fallback={null}>
          <FilePreview path={pane.tab.path} relative={pane.tab.relative} actions={null} active={pane.visible} />
        </Suspense>
      )}
    </div>
  ));
}
