import { useCallback, useEffect, useRef, useState } from "react";
import { Share2 } from "lucide-react";
import EditorCanvas from "./components/EditorCanvas";
import Sidebar from "./components/Sidebar";
import SessionTitleDialog from "./components/SessionTitleDialog";
import ShareDialog from "./components/ShareDialog";
import { useStore } from "./store/useStore";
import { createSessionSnapshot } from "./session/createSessionSnapshot";
import { createShare, fetchSharedSnapshot } from "./share/shareApi";
import { createUuid } from "./utils/createUuid";
import { isUuid } from "./utils/isUuid";
import { parseSessionSnapshot } from "./session/parseSessionSnapshot";
import messagePassingSessionRaw from "../tests/session-samples/message-passing.json";

const defaultSessionSnapshot = (() => {
  try {
    return parseSessionSnapshot(messagePassingSessionRaw);
  } catch (error) {
    console.error("Failed to parse default session JSON.", error);
    return null;
  }
})();

const App = () => {
  const [sharedSessionId] = useState(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const trimmedPath = window.location.pathname.replace(/^\/+|\/+$/g, "");
    if (!trimmedPath) {
      return null;
    }
    return isUuid(trimmedPath) ? trimmedPath : null;
  });
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const validateGraph = useStore((state) => state.validateGraph);
  const sessionTitle = useStore((state) => state.sessionTitle);
  const setSessionTitle = useStore((state) => state.setSessionTitle);
  const modelConfig = useStore((state) => state.modelConfig);
  const memoryEnv = useStore((state) => state.memoryEnv);
  const threads = useStore((state) => state.threads);
  const activeBranch = useStore((state) => state.activeBranch);
  const importSession = useStore((state) => state.importSession);
  const seeded = useRef(false);
  const [shareNamingOpen, setShareNamingOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<{
    id: string;
    url: string;
  } | null>(null);
  const [sharedLoadError, setSharedLoadError] = useState<string | null>(null);
  const [sharedLoadPending, setSharedLoadPending] = useState(() =>
    Boolean(sharedSessionId)
  );

  const shareSession = useCallback(
    async (title: string) => {
      const normalizedTitle = title.trim() || "Untitled";
      setSessionTitle(normalizedTitle);

      const snapshot = createSessionSnapshot({
        title: normalizedTitle,
        modelConfig,
        memoryEnv,
        nodes,
        edges,
        threads,
        activeBranch,
      });

      const id = createUuid();
      setShareLoading(true);
      setShareError(null);
      try {
        await createShare({ id, snapshot });
        const url = `${window.location.origin}/${id}`;
        setShareLink({ id, url });
        setShareDialogOpen(true);
      } catch (error) {
        setShareError(
          error instanceof Error ? error.message : "Failed to share session."
        );
      } finally {
        setShareLoading(false);
      }
    },
    [
      activeBranch,
      edges,
      memoryEnv,
      modelConfig,
      nodes,
      setSessionTitle,
      threads,
    ]
  );

  const handleShare = useCallback(() => {
    if (!sessionTitle.trim()) {
      setShareNamingOpen(true);
      return;
    }

    void shareSession(sessionTitle);
  }, [sessionTitle, shareSession]);

  useEffect(() => {
    if (!sharedSessionId) {
      return;
    }

    let active = true;
    setSharedLoadPending(true);
    setSharedLoadError(null);

    void (async () => {
      try {
        const shared = await fetchSharedSnapshot(sharedSessionId);
        const parsed = parseSessionSnapshot(shared);
        if (!active) {
          return;
        }
        importSession(parsed);
        setSharedLoadPending(false);
      } catch (error) {
        if (!active) {
          return;
        }
        setSharedLoadError(
          error instanceof Error
            ? error.message
            : "Failed to load shared session."
        );
        setSharedLoadPending(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [importSession, sharedSessionId]);

  useEffect(() => {
    if (sharedSessionId) {
      return;
    }
    if (seeded.current || nodes.length > 0) {
      return;
    }

    seeded.current = true;
    // Load the default session once on first load.
    if (defaultSessionSnapshot) {
      importSession(defaultSessionSnapshot);
    }
  }, [importSession, nodes.length, sharedSessionId]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 text-slate-900">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <div>
            <div className="text-sm font-semibold tracking-wide">
              Litmus Explorer
            </div>
            <div className="text-xs text-slate-500">
              Drag operations, connect relations, and collapse branches.
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="max-w-[28rem] truncate text-xs font-medium text-slate-700">
              <span className="text-slate-500">Session:</span>{" "}
              {sessionTitle ? sessionTitle : "Untitled"}
            </div>
            {shareError ? (
              <div className="max-w-[20rem] truncate text-xs text-rose-600">
                {shareError}
              </div>
            ) : null}
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleShare}
              disabled={shareLoading}
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
              {shareLoading ? "Sharing…" : "Share"}
            </button>
            <button
              type="button"
              className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
              onClick={validateGraph}
            >
              Validate Graph
            </button>
          </div>
        </header>
        <main className="flex-1">
          {sharedSessionId && sharedLoadPending ? (
            <div className="flex h-full items-center justify-center px-6 text-sm text-slate-600">
              Loading shared session…
            </div>
          ) : sharedSessionId && sharedLoadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="text-sm font-semibold text-slate-900">
                Could not load shared session
              </div>
              <div className="max-w-md text-sm text-slate-600">
                {sharedLoadError}
              </div>
              <button
                type="button"
                className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
                onClick={() => window.location.assign("/")}
              >
                Go home
              </button>
            </div>
          ) : (
            <EditorCanvas />
          )}
        </main>
      </div>

      <SessionTitleDialog
        open={shareNamingOpen}
        initialValue={sessionTitle}
        title="Name session to share"
        description="This name will be embedded in the shared JSON."
        confirmLabel="Share"
        onCancel={() => setShareNamingOpen(false)}
        onConfirm={(title) => {
          setShareNamingOpen(false);
          void shareSession(title);
        }}
      />

      <ShareDialog
        open={shareDialogOpen && shareLink !== null}
        shareId={shareLink?.id ?? ""}
        shareUrl={shareLink?.url ?? ""}
        onClose={() => setShareDialogOpen(false)}
      />
    </div>
  );
};

export default App;
