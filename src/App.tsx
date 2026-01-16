import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, Share2, SlidersHorizontal } from "lucide-react";
import EditorCanvas from "./components/EditorCanvas";
import Sidebar from "./components/Sidebar";
import ModelSidebar from "./components/ModelSidebar";
import SessionTitleDialog from "./components/SessionTitleDialog";
import ShareDialog from "./components/ShareDialog";
import { useStore } from "./store/useStore";
import { createSessionSnapshot } from "./session/createSessionSnapshot";
import { createShare, fetchSharedSnapshot } from "./share/shareApi";
import { createUuid } from "./utils/createUuid";
import { isUuid } from "./utils/isUuid";
import { parseSessionSnapshot } from "./session/parseSessionSnapshot";
import { useMediaQuery } from "./utils/useMediaQuery";
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
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia("(min-width: 1024px)").matches;
  });
  const [isModelSidebarDockedOpen, setIsModelSidebarDockedOpen] = useState(() => {
    if (typeof window === "undefined") {
      return true;
    }
    const stored = window.localStorage.getItem("litmus.modelSidebarDockedOpen");
    if (stored === "true" || stored === "false") {
      return stored === "true";
    }
    return typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 1024px)").matches
      : true;
  });
  const [isModelSidebarDrawerOpen, setIsModelSidebarDrawerOpen] = useState(false);
  const [sharedSessionId, setSharedSessionId] = useState<string | null>(() => {
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
  const markSessionSaved = useStore((state) => state.markSessionSaved);
  const modelConfig = useStore((state) => state.modelConfig);
  const memoryEnv = useStore((state) => state.memoryEnv);
  const threads = useStore((state) => state.threads);
  const threadLabels = useStore((state) => state.threadLabels);
  const activeBranch = useStore((state) => state.activeBranch);
  const importSession = useStore((state) => state.importSession);
  const seeded = useRef(false);
  const sharedLoadVersion = useRef(0);
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

  /**
   * Clears any shared-session UUID from the URL without reloading the page.
   * This deliberately does not navigate to `/` via `location.assign`, because
   * that would trigger the default litmus seed on a fresh load.
   */
  const handleNewSession = useCallback(() => {
    seeded.current = true;
    sharedLoadVersion.current += 1;
    setSharedSessionId(null);
    setSharedLoadPending(false);
    setSharedLoadError(null);

    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/");
    }
  }, []);

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
        threadLabels,
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
        markSessionSaved();
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
      markSessionSaved,
      modelConfig,
      nodes,
      setSessionTitle,
      threadLabels,
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

    const loadVersion = (sharedLoadVersion.current += 1);
    let active = true;
    setSharedLoadPending(true);
    setSharedLoadError(null);

    void (async () => {
      try {
        const shared = await fetchSharedSnapshot(sharedSessionId);
        const parsed = parseSessionSnapshot(shared);
        if (!active || sharedLoadVersion.current !== loadVersion) {
          return;
        }
        importSession(parsed);
        setSharedLoadPending(false);
      } catch (error) {
        if (!active || sharedLoadVersion.current !== loadVersion) {
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

  /**
   * Keep the sidebar "docked open" on desktop and closed-by-default on phones.
   * This runs after the first render so the initial value can be derived from
   * `matchMedia` without a layout flash.
   */
  useEffect(() => {
    setIsSidebarOpen(isDesktop);
  }, [isDesktop]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      "litmus.modelSidebarDockedOpen",
      String(isModelSidebarDockedOpen)
    );
  }, [isModelSidebarDockedOpen]);

  useEffect(() => {
    if (isDesktop || !isSidebarOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSidebarOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDesktop, isSidebarOpen]);

  useEffect(() => {
    if (isDesktop || !isModelSidebarDrawerOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsModelSidebarDrawerOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDesktop, isModelSidebarDrawerOpen]);

  useEffect(() => {
    if (isDesktop) {
      setIsModelSidebarDrawerOpen(false);
    }
  }, [isDesktop]);

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
    <div className="flex h-dvh w-dvw overflow-hidden bg-slate-100 text-slate-900">
      {isDesktop ? (
        <Sidebar onNewSession={handleNewSession} />
      ) : (
        <>
          {isSidebarOpen ? (
            <div
              className="fixed inset-0 z-40 bg-slate-900/30"
              role="button"
              tabIndex={0}
              aria-label="Close sidebar overlay"
              onClick={() => setIsSidebarOpen(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  setIsSidebarOpen(false);
                }
              }}
            />
          ) : null}
          <div className="fixed inset-y-0 left-0 z-50">
            <Sidebar
              onNewSession={handleNewSession}
              variant="drawer"
              open={isSidebarOpen}
              onRequestClose={() => setIsSidebarOpen(false)}
            />
          </div>
        </>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-col gap-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-6 sm:py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                className="inline-flex h-9 w-9 flex-none items-center justify-center rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1 lg:hidden"
                onClick={() => setIsSidebarOpen(true)}
                aria-label="Open sidebar"
              >
                <Menu className="h-4 w-4" aria-hidden="true" />
              </button>
                <div className="min-w-0">
                  <div className="text-sm font-semibold tracking-wide">
                    Litmus Explorer
                  </div>
                <div className="hidden text-xs text-slate-500 sm:block">
                  Drag operations, connect relations, and collapse branches.
                </div>
              </div>
            </div>
            <div className="flex flex-none items-center gap-2 sm:gap-4">
              <button
                type="button"
                className="inline-flex h-9 w-9 flex-none items-center justify-center rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1 lg:hidden"
                onClick={() => setIsModelSidebarDrawerOpen(true)}
                aria-label="Open model sidebar"
              >
                <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-60 sm:px-3"
                onClick={handleShare}
                disabled={shareLoading}
              >
                <Share2 className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">
                  {shareLoading ? "Sharing…" : "Share"}
                </span>
              </button>
              <button
                type="button"
                className="rounded bg-slate-900 px-2 py-1.5 text-xs font-semibold text-white sm:px-3"
                onClick={validateGraph}
              >
                <span className="hidden sm:inline">Validate Graph</span>
                <span className="sm:hidden">Validate</span>
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="max-w-full truncate text-xs font-medium text-slate-700 sm:max-w-[28rem]">
              <span className="text-slate-500">Session:</span>{" "}
              {sessionTitle ? sessionTitle : "Untitled"}
            </div>
            {shareError ? (
              <div className="max-w-full truncate text-xs text-rose-600 sm:max-w-[20rem]">
                {shareError}
              </div>
            ) : null}
          </div>
        </header>
        <main className="min-h-0 flex-1">
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
      {isDesktop ? (
        <ModelSidebar
          open={isModelSidebarDockedOpen}
          onToggleOpen={() => setIsModelSidebarDockedOpen((current) => !current)}
        />
      ) : (
        <>
          {isModelSidebarDrawerOpen ? (
            <div
              className="fixed inset-0 z-40 bg-slate-900/30"
              role="button"
              tabIndex={0}
              aria-label="Close model sidebar overlay"
              onClick={() => setIsModelSidebarDrawerOpen(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  setIsModelSidebarDrawerOpen(false);
                }
              }}
            />
          ) : null}
          <div className="fixed inset-y-0 right-0 z-50">
            <ModelSidebar
              variant="drawer"
              open={isModelSidebarDrawerOpen}
              onRequestClose={() => setIsModelSidebarDrawerOpen(false)}
            />
          </div>
        </>
      )}

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
