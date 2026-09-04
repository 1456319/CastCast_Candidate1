// EDITING OF THIS FILE MAY CAUSE CATASTROPHIC APP DESYCHRONIZATION. Reference the directory at at ~/docs/synchronization_map.md to determine what other files must be adjusted in order to ensure absolute synchronization is maintained. This is to ensure that the APK, termux daemon, and chromecast portions of the app are always in synchronous, deterministic states.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Cast,
  ChevronDown,
  CircleAlert,
  Copy,
  FileVideo,
  HelpCircle,
  Link2,
  Link2Off,
  Loader2,
  LogIn,
  Pause,
  Play,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Subtitles,
  Wifi,
  Trash2,
  Volume2,
  VolumeX,
  Gamepad2,
  FastForward,
  Rewind,
} from "lucide-react";
import {
  DAEMON_BASE,
  daemon,
  formatBytes,
  formatDuration,
  subscribe,
  type HealthReport,
  type LibraryItem,
  type LogLine,
  type Preflight,
  type Status,
} from "./lib/daemon";
import { PreflightPanel } from "./components/preflight-panel";
import { TERMUX_MANUAL_COMMAND, launchTermuxDaemon, getSharedUrl } from "./lib/termux-daemon";
import { DiscoveryBrowser } from "./lib/discovery-browser";
import { Explain, LongPressHelpProvider } from "./components/long-press-help";
import {
  Drawer,
  DrawerContent,
  DrawerTrigger,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription
} from "./components/ui/drawer";

const LIVE_STATES = new Set(["playing", "buffering", "paused", "loading"]);

const STATE_TONE: Record<string, string> = {
  playing: "text-emerald-400",
  buffering: "text-amber-400",
  paused: "text-emerald-300/70",
  loading: "text-amber-400",
  connected: "text-emerald-400/70",
  ready: "text-emerald-400/70",
  connecting: "text-amber-400",
  disconnected: "text-emerald-500/40",
  load_failed: "text-rose-400",
  dead: "text-rose-400",
};

// Only surface daemon/setup-related notices on the offline gate so a stale
// message from the main screen never leaks into the splash.
const GATE_NOTICE = /termux|daemon|unresponsive|failed to fetch|install|storage/i;

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [trashItems, setTrashItems] = useState<LibraryItem[]>([]);
  const [amazonQueue, setAmazonQueue] = useState<any[]>([]);
  const [maxVerbosityLogs, setMaxVerbosityLogs] = useState<string | null>(null);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [report, setReport] = useState<Preflight | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [showDebugLogs, setShowDebugLogs] = useState(false);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [host, setHost] = useState("192.168.1.50");
  const [notice, setNotice] = useState<string | null>(null);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const [missingDep, setMissingDep] = useState<string | null>(null);
  const [selectedAudioId, setSelectedAudioId] = useState<number | null>(null);
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<number | null>(null);

  // Advanced / DRM cast fields (behind a disclosure in pre-flight).
  const [advancedCastOpen, setAdvancedCastOpen] = useState(false);
  const [drmLicenseUrl, setDrmLicenseUrl] = useState("");
  const [drmToken, setDrmToken] = useState("");
  const [autoPrepare, setAutoPrepare] = useState(true);

  // Amazon device-code login.
  const [amazonAuthData, setAmazonAuthData] = useState<any | null>(null);
  const [amazonStatus, setAmazonStatus] = useState<string | null>(null);
  const [amazonLinked, setAmazonLinked] = useState<boolean>(
    () => typeof localStorage !== "undefined" && localStorage.getItem("castcast.amazonLinked") === "1",
  );
  const [amazonAdvancedOpen, setAmazonAdvancedOpen] = useState(false);
  const [amazonTokensText, setAmazonTokensText] = useState("");
  const amazonPollRef = useRef<number | null>(null);

  const [lpHintDismissed, setLpHintDismissed] = useState<boolean>(
    () => typeof localStorage !== "undefined" && localStorage.getItem("castcast.lpHint") === "1",
  );

  const logRef = useRef<HTMLDivElement>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const [anomaly, setAnomaly] = useState<any | null>(null);

  const statusRef = useRef<Status | null>(null);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await daemon.status());
      setOnline(true);
      setNotice((prev) => (prev === 'Daemon process found, but unresponsive. You may need to Force Stop Termux.' ? null : prev));
    } catch (err: any) {
      setOnline(false);
      if (err instanceof Error && (err.message.includes('500') || err.name === 'SyntaxError' || err.message.includes('Unexpected token') || err.message.includes('Unexpected end of JSON input') || err.message.includes('Failed to parse'))) {
        setNotice('Daemon process found, but unresponsive. You may need to Force Stop Termux.');
      } else if (err instanceof Error && err.message.includes('Failed to fetch')) {
        setNotice((prev) => (prev === 'Daemon process found, but unresponsive. You may need to Force Stop Termux.' ? null : prev));
      }
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await daemon.health());
    } catch {
      /* daemon offline or older build without /health; leave prior value */
    }
  }, []);

  // Live stream from the daemon, plus a slow poll as a safety net.
  useEffect(() => {
    refreshStatus();
    loadHealth();
    const unsubscribe = subscribe({
      onOpen: () => {
        setOnline(true);
        loadHealth();
      },
      onError: () => setOnline(false),
      onStatus: (s) => {
        setStatus(s);
        setOnline(true);
      },
      onLog: (line) => setLogs((prev) => [...prev.slice(-300), line]),
      onState: refreshStatus,
      onRemux: refreshStatus,
      onMedia: (media) =>
        setStatus((prev) => (prev ? { ...prev, cast: { ...prev.cast, ...media } } : prev)),
      onTelemetryAnomaly: (data) => setAnomaly(data),
      onAmazonQueue: (data) => setAmazonQueue((data as any).items || []),
    });
    unsubscribeRef.current = unsubscribe;
    const timer = window.setInterval(refreshStatus, 5000);
    pollTimerRef.current = timer;
    return () => {
      unsubscribe();
      unsubscribeRef.current = null;
      window.clearInterval(timer);
      pollTimerRef.current = null;
      if (amazonPollRef.current !== null) {
        window.clearInterval(amazonPollRef.current);
        amazonPollRef.current = null;
      }
    };
  }, [refreshStatus, loadHealth]);

  // Smooth the position clock between MEDIA_STATUS messages.
  useEffect(() => {
    if (status?.cast?.state !== "playing") return;
    const timer = window.setInterval(() => {
      setStatus((prev) =>
        prev && prev.cast.state === "playing"
          ? { ...prev, cast: { ...prev.cast, position: prev.cast.position + 1 } }
          : prev,
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status?.cast?.state]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      await refreshStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const match = msg.match(/No such file or directory: '([^']+)'/);
      if (match) {
        setMissingDep(match[1]);
        setNotice(`'${match[1]}' is not installed. Install it?`);
      } else {
        setNotice(msg);
      }
    } finally {
      setBusy(null);
    }
  };

  const copyText = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
      setNotice("Copied to clipboard.");
    } catch {
      /* clipboard unavailable */
    }
  };

  const dismissLpHint = () => {
    setLpHintDismissed(true);
    try {
      localStorage.setItem("castcast.lpHint", "1");
    } catch {
      /* storage unavailable */
    }
  };

  const checkSharedUrl = useCallback(async () => {
    try {
      const result = await getSharedUrl();
      if (result.url) {
        const urlStr = result.url as string;
        const isAmazon = urlStr.includes("amazon.com") || urlStr.includes("primevideo.com") || urlStr.includes("gti=");
        const isPlaying = statusRef.current?.cast?.state && statusRef.current.cast.state !== "idle" && statusRef.current.cast.state !== "IDLE" && statusRef.current.cast.state !== "unknown" && statusRef.current.cast.state !== "dead" && statusRef.current.cast.state !== "disconnected";

        if (isAmazon && isPlaying) {
          setNotice(`Adding Amazon video to queue...`);
          try {
            await daemon.addAmazonQueue(urlStr);
            setNotice(`Added to Amazon Queue.`);
            await loadLibrary();
          } catch (err) {
            setNotice(`Failed to add to queue: ${err}`);
          }
        } else {
          setNotice(`Extracting streams, please wait...`);
          try {
            await daemon.cast(urlStr, true, undefined, undefined, "Amazon Video");
            setNotice(`Success! Sending stream to TV...`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const match = msg.match(/No such file or directory: '([^']+)'/);
            if (match) {
              setMissingDep(match[1]);
              setNotice(`'${match[1]}' is not installed. Install it?`);
            } else {
              setNotice(msg);
            }
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    checkSharedUrl();
    const handleVis = () => { if (document.visibilityState === "visible") checkSharedUrl(); };
    document.addEventListener("visibilitychange", handleVis);
    return () => document.removeEventListener("visibilitychange", handleVis);
  }, [checkSharedUrl]);

  useEffect(() => {
    const handle = DiscoveryBrowser.addListener("onStreamDetected", async (event) => {
      console.log("Stream detected from WebView!", event);
      try {
        await daemon.interceptDiscovery(event);
      } catch (err) {
        console.error("Failed to bridge interception to daemon", err);
      }
    });
    return () => { handle.then(h => h.remove()); };
  }, []);

  const launchDaemon = () =>
    run("launch-daemon", async () => {
      setLaunchMessage("Sending Termux RUN_COMMAND intent…");
      const result = await launchTermuxDaemon();
      setLaunchMessage(
        `Root configured Termux and sent launch request. Waiting for ${DAEMON_BASE}. Audit log: ${result.auditLog ?? "/storage/emulated/0/Download/CastCast/Chromecast/.castcast/audit.log"}. ${result.note ?? ""}`.trim(),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      await refreshStatus();
    });

  const loadLibrary = () =>
    run("library", async () => {
      const libRes = await daemon.library(false);
      if ((libRes as any).error) throw new Error((libRes as any).error);
      setLibrary(libRes.items || []);

      const trashRes = await daemon.getTrash();
      if ((trashRes as any).error) throw new Error((trashRes as any).error);
      setTrashItems(trashRes.items || []);

      try {
        const amzRes = await daemon.getAmazonQueue();
        setAmazonQueue(amzRes.items || []);
      } catch (e) {
        setAmazonQueue([]);
      }
    });

  // ---- Amazon device-code login -------------------------------------
  const stopAmazonPolling = () => {
    if (amazonPollRef.current !== null) {
      window.clearInterval(amazonPollRef.current);
      amazonPollRef.current = null;
    }
  };

  const markAmazonLinked = () => {
    setAmazonLinked(true);
    setAmazonAuthData(null);
    stopAmazonPolling();
    try {
      localStorage.setItem("castcast.amazonLinked", "1");
    } catch {
      /* storage unavailable */
    }
  };

  const startAmazonLink = async () => {
    stopAmazonPolling();
    setAmazonStatus("Requesting a login code from Amazon…");
    try {
      const data = await daemon.amazonAuth();
      const pub = data?.public_code ?? data?.code_data?.public_code;
      const priv = data?.private_code ?? data?.code_data?.private_code;
      if (!pub || !priv) {
        setAmazonStatus(`Unexpected response from Amazon: ${JSON.stringify(data)}`);
        return;
      }
      setAmazonAuthData({ ...data, public_code: pub, private_code: priv });
      setAmazonStatus("Enter the code at amazon.com/code, then keep this open — we'll detect it automatically.");

      let tries = 0;
      amazonPollRef.current = window.setInterval(async () => {
        tries += 1;
        if (tries > 24) {
          // ~2 minutes; codes expire, tell the user to retry.
          stopAmazonPolling();
          setAmazonStatus("Login code expired. Tap Link Amazon Account to get a fresh code.");
          setAmazonAuthData(null);
          return;
        }
        try {
          const res = await daemon.amazonPoll(pub, priv);
          if (res?.response?.success || res?.success) {
            setAmazonStatus("Amazon account linked.");
            markAmazonLinked();
          }
        } catch {
          // Amazon returns an error until the user authorizes; keep polling.
        }
      }, 5000);
    } catch (err) {
      setAmazonStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const injectAmazonTokens = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(amazonTokensText);
    } catch {
      setAmazonStatus("That is not valid JSON. Paste the full amazon_auth.json contents.");
      return;
    }
    try {
      await daemon.injectAmazon(parsed);
      setAmazonStatus("Amazon tokens injected.");
      markAmazonLinked();
      setAmazonTokensText("");
    } catch (err) {
      setAmazonStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const unlinkAmazon = () => {
    setAmazonLinked(false);
    setAmazonAuthData(null);
    setAmazonStatus(null);
    stopAmazonPolling();
    try {
      localStorage.removeItem("castcast.amazonLinked");
    } catch {
      /* storage unavailable */
    }
  };

  const removeAmazonItem = async (index: number) => {
    // Optimistic local removal, then hit the dedicated index-based endpoint and
    // reconcile against the daemon's authoritative order.
    setAmazonQueue((prev) => prev.filter((_, i) => i !== index));
    try {
      await daemon.removeAmazonQueue(index);
    } catch (err) {
      console.error(err);
    } finally {
      try {
        const amzRes = await daemon.getAmazonQueue();
        setAmazonQueue(amzRes.items || []);
      } catch {
        /* keep optimistic state */
      }
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number, type: 'library' | 'amazon') => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ index, type }));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent, dropIndex: number, type: 'library' | 'amazon') => {
    e.preventDefault();
    const dataStr = e.dataTransfer.getData("text/plain");
    if (!dataStr) return;
    try {
      const data = JSON.parse(dataStr);
      if (data.type !== type) return;
      if (data.index === dropIndex) return;

      if (type === 'library') {
        // Local-only reorder: the daemon has no library-order endpoint, so this
        // affects the current session's cast-queue ordering only.
        const newItems = [...library];
        const [moved] = newItems.splice(data.index, 1);
        newItems.splice(dropIndex, 0, moved);
        setLibrary(newItems);
      } else {
        const newItems = [...amazonQueue];
        const [moved] = newItems.splice(data.index, 1);
        newItems.splice(dropIndex, 0, moved);
        setAmazonQueue(newItems);
        try {
          await daemon.reorderAmazonQueue(newItems);
        } catch (err) {
          console.error(err);
        } finally {
          const amzRes = await daemon.getAmazonQueue();
          setAmazonQueue(amzRes.items || []);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const trashFile = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    run("trash", async () => {
      await daemon.trash(path);
      await loadLibrary();
    });
  };

  const deleteFile = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    run("delete", async () => {
      await daemon.delete(path);
      await loadLibrary();
    });
  };

  const emptyTrash = () =>
    run("empty-trash", async () => {
      for (const item of trashItems) {
        const result = await daemon.delete(item.path);
        if (result.error) throw new Error(`${item.rel}: ${result.error}`);
      }
      await loadLibrary();
      setNotice("Trash emptied permanently.");
    });

  const select = (item: LibraryItem) =>
    run("preflight", async () => {
      setSelected(item);
      setSelectedAudioId(null);
      setSelectedSubtitleId(null);
      setReport(null);
      setReport(await daemon.preflight(item.path));
    });

  const markLoading = (name: string, path: string) =>
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            cast: {
              ...prev.cast,
              state: "loading",
              title: name,
              source_path: path,
            },
          }
        : prev,
    );

  const doCast = (allowUnsafe = false) =>
    selected &&
    run("cast", async () => {
      const result = await daemon.cast(
        selected.path,
        allowUnsafe,
        selectedAudioId,
        selectedSubtitleId,
        selected.title,
        {
          licenseUrl: drmLicenseUrl.trim() || null,
          offlineDrmToken: drmToken.trim() || null,
          autoPrepare,
        },
      );
      if (result.error) setNotice(result.error);
      if (result.converting) setNotice("Conversion started — cast again when it finishes.");
      if (result.casting) markLoading(selected.name, selected.path);
      setReport((prev) => ({ ...(prev || {}), ...result } as Preflight));
    });


  const castQueue = () =>
    run("queue", async () => {
      if (!library.length) throw new Error("Scan the queue before casting it.");
      const selectedIndex = selected ? library.findIndex((item) => item.path === selected.path) : -1;
      const ordered = selectedIndex >= 0
        ? [...library.slice(selectedIndex), ...library.slice(0, selectedIndex)]
        : library;
      const result = await daemon.queue(ordered.map((item) => item.path));
      if (result.error) throw new Error(result.error);
      const first = ordered[0];
      markLoading(first.name, first.path);
      setNotice(`Queued ${result.queued ?? 0} item(s); ${result.preparing ?? 0} preparing, ${result.skipped ?? 0} skipped.`);
    });

  const requestSubtitles = () =>
    cast?.source_path &&
    run("subtitles", async () => {
      const result = await daemon.requestOpenSubtitles(cast.source_path, "eng");
      if (result.error) setNotice(result.error);
      else setNotice("English subtitles loaded from OpenSubtitles.");
    });

  const cast = status?.cast;
  const live = cast ? LIVE_STATES.has(cast.state) : false;
  const remux = status?.remux;

  // ---- daemon offline ------------------------------------------------
  if (!online) {
    const gateMessage = launchMessage || (notice && GATE_NOTICE.test(notice) ? notice : null);
    return (
      <LongPressHelpProvider>
        <div className="min-h-screen bg-[#050807] p-6 text-emerald-300" style={{ fontFamily: "'Exo 2', sans-serif" }}>
          <div className="mx-auto max-w-md space-y-4 pt-16">
            <div className="flex items-center gap-2 text-emerald-400">
              <CircleAlert className="h-5 w-5" />
              <span>{notice && notice.includes("unresponsive") ? "daemon zombie detected" : "daemon unreachable"}</span>
            </div>
            <p className="text-emerald-500/70">
              This UI is a face for the <span className="font-mono">castcast</span> daemon. A browser
              cannot speak CASTv2 itself — the protocol needs a raw TLS socket — so the daemon does all
              the device work and this talks to it over localhost.
            </p>
            <Explain
              title="Launch Daemon (Termux)"
              text="Starts the castcast daemon inside Termux on this phone by sending it a RUN_COMMAND intent. The daemon is what actually talks to your Chromecast; nothing here works until it is running and reachable at the address shown below. Only works inside the CastCast app — in a plain browser, use the manual command underneath."
            >
              <button
                type="button"
                onClick={launchDaemon}
                disabled={busy === "launch-daemon"}
                className="block w-full rounded border border-emerald-500/50 bg-emerald-500/20 px-4 py-3 text-center font-bold tracking-wide text-emerald-100 shadow-lg hover:bg-emerald-500/30 disabled:cursor-wait disabled:opacity-60"
              >
                {busy === "launch-daemon" ? "Launching Termux…" : "Launch Daemon (Termux)"}
              </button>
            </Explain>
            <div className="font-mono text-emerald-500/50">expecting: {DAEMON_BASE}</div>
            {gateMessage && (
              <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300">
                {gateMessage}
              </div>
            )}
            <div className="rounded border border-emerald-500/20 bg-black/40 p-3 text-xs text-emerald-500/70">
              <div className="mb-1 text-emerald-400/80">Manual fallback command:</div>
              <code className="break-words font-mono">{TERMUX_MANUAL_COMMAND}</code>
            </div>
            <Explain
              title="Retry"
              text="Re-checks whether the daemon has come online yet by polling its /status endpoint. Use this after launching Termux or running the manual command."
            >
              <button
                onClick={() => run("retry", refreshStatus)}
                disabled={busy === "retry"}
                className="rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-wait disabled:opacity-60"
              >
                {busy === "retry" ? "checking…" : "retry"}
              </button>
            </Explain>
            <p className="pt-2 text-center text-xs text-emerald-500/40">
              Tip: long-press any control for an explanation.
            </p>
          </div>
        </div>
      </LongPressHelpProvider>
    );
  }

  const healthBlocking = health?.blocking?.length ?? 0;

  // ---- main ----------------------------------------------------------
  return (
    <LongPressHelpProvider>
    <div
      className="min-h-screen bg-[#050807] text-emerald-300"
      style={{ fontFamily: "'Exo 2', sans-serif" }}
    >
      <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
        {/* header */}
        <header className="flex items-center justify-between border-b border-emerald-500/20 pb-3">
          <div className="flex items-center gap-2">
            <Cast className="h-5 w-5 text-emerald-400" />
            <span className="tracking-wide">castcast</span>
          </div>
          <div className="flex items-center gap-2">
            <Explain
              title="Readiness"
              text={
                health
                  ? "Shows whether the daemon can actually cast right now: media server bound, a real LAN address, ffmpeg/ffprobe present, and your media folder readable. Tap to expand each check and its exact fix-it command."
                  : "Readiness checks (media server, LAN, ffmpeg/ffprobe, storage). Waiting for the daemon to report."
              }
            >
              <button
                onClick={() => {
                  setHealthOpen((v) => !v);
                  loadHealth();
                }}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
                  health
                    ? health.ready
                      ? "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                      : "border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
                    : "border-emerald-500/25 text-emerald-500/60 hover:bg-emerald-500/10"
                }`}
              >
                {health ? (
                  health.ready ? <ShieldCheck className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />
                ) : (
                  <Activity className="h-3.5 w-3.5" />
                )}
                {health ? (health.ready ? "ready" : `${healthBlocking} blocking`) : "health"}
              </button>
            </Explain>
            <Explain
              title="Discovery Mode"
              text="Opens an in-app browser you point at a streaming page. When it detects a video manifest (HLS/DASH) or DRM stream, it hands that stream to the daemon so it can be cast — a way to grab streams the app cannot open directly."
            >
              <button
                onClick={() => {
                  const url = prompt("Enter a URL to discover (e.g. https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8):", "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
                  if (url) DiscoveryBrowser.open({ url });
                }}
                className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
              >
                Discovery Mode
              </button>
            </Explain>
            <div className="flex items-center gap-2 font-mono text-emerald-500/60">
              <Wifi className="h-3.5 w-3.5" />
              {status?.media_server.lan_ip}:{status?.media_server.port}
            </div>
          </div>
        </header>

        {!lpHintDismissed && (
          <div className="flex items-center justify-between rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-400/80">
            <span className="flex items-center gap-1.5">
              <HelpCircle className="h-3.5 w-3.5" />
              Tip: long-press almost any control for an explanation of what it does.
            </span>
            <button onClick={dismissLpHint} className="text-emerald-500/60 hover:text-emerald-300">
              got it
            </button>
          </div>
        )}

        {/* readiness dashboard */}
        {healthOpen && (
          <section className="rounded border border-emerald-500/20 bg-black/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-emerald-500/50 uppercase tracking-wider">readiness</span>
              <div className="flex items-center gap-2">
                {health && (
                  <span className={`font-mono text-xs ${health.ready ? "text-emerald-400" : "text-rose-400"}`}>
                    {health.ready ? "ready to cast" : "not ready"}
                  </span>
                )}
                <Explain title="Refresh readiness" text="Re-runs the daemon's readiness checklist right now.">
                  <button
                    onClick={loadHealth}
                    className="flex items-center gap-1.5 text-emerald-400/70 hover:text-emerald-300"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </Explain>
              </div>
            </div>
            {!health ? (
              <div className="py-3 text-center text-emerald-500/40">waiting for the daemon…</div>
            ) : (
              <div className="space-y-1.5">
                {health.checks.map((check) => {
                  const tone =
                    check.ok === true
                      ? "text-emerald-400"
                      : check.ok === false
                        ? check.blocking
                          ? "text-rose-400"
                          : "text-amber-400"
                        : "text-emerald-500/40";
                  const glyph = check.ok === true ? "✓" : check.ok === false ? "✕" : "?";
                  return (
                    <Explain
                      key={check.key}
                      title={check.label}
                      text={`${check.detail || "No detail."}${check.remedy ? `\n\nFix: ${check.remedy}` : ""}`}
                    >
                      <div className="rounded border border-emerald-500/10 bg-black/30 px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className={`font-mono ${tone}`}>{glyph}</span>
                          <span className="min-w-0 flex-1 truncate text-emerald-200">{check.label}</span>
                          {!check.blocking && check.ok === false && (
                            <span className="shrink-0 rounded border border-amber-500/30 px-1.5 text-[10px] uppercase text-amber-400/80">
                              optional
                            </span>
                          )}
                        </div>
                        {check.detail && (
                          <div className="mt-0.5 pl-5 text-xs text-emerald-500/50">{check.detail}</div>
                        )}
                        {check.remedy && check.ok !== true && (
                          <div className="mt-1 flex items-center gap-2 pl-5">
                            <code className="min-w-0 flex-1 truncate font-mono text-xs text-amber-300">{check.remedy}</code>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                copyText(check.remedy);
                              }}
                              className="shrink-0 text-emerald-500/50 hover:text-emerald-300"
                              title="copy fix command"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </Explain>
                  );
                })}
                {health.serve_command && (
                  <div className="mt-2 flex items-center gap-2 border-t border-emerald-500/10 pt-2">
                    <span className="shrink-0 text-xs text-emerald-500/50">serve:</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-400/70">{health.serve_command}</code>
                    <button onClick={() => copyText(health.serve_command)} className="shrink-0 text-emerald-500/50 hover:text-emerald-300" title="copy">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {notice && (
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-amber-300">
            {notice}
          </div>
        )}

        {!status?.tools.ffprobe && (
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-amber-300">
            ffprobe not found — pre-flight checks are disabled, so unsupported files will fail
            silently on the device. <span className="font-mono">pkg install ffmpeg</span>
          </div>
        )}

        {status && !status.tools.yt_dlp && (
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-amber-300">
            yt-dlp not found — YouTube sharing is disabled. Run <span className="font-mono">pip install yt-dlp</span> in Termux.
          </div>
        )}

        {missingDep && (
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 flex items-center justify-between text-amber-300">
            <div>Open Termux and run: <span className="font-mono">pip install {missingDep}</span></div>
            <button
              onClick={() => {
                setMissingDep(null);
                setNotice(null);
                checkSharedUrl();
              }}
              className="rounded border border-amber-500/40 bg-amber-500/10 px-4 py-1 hover:bg-amber-500/20"
            >
              Done
            </button>
          </div>
        )}

        {/* connection */}
        <section className="rounded border border-emerald-500/20 bg-black/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-emerald-500/50 uppercase tracking-wider">device</span>
            <span className={`font-mono ${STATE_TONE[cast?.state ?? ""] ?? "text-emerald-500/50"}`}>
              {cast?.state ?? "unknown"}
            </span>
          </div>

          {status?.device ? (
            <div className="flex items-center justify-between">
              <div>
                <div className="text-emerald-200">{status.device.friendly_name}</div>
                <div className="font-mono text-emerald-500/50">
                  {status.device.host}
                  {cast && cast.reconnects > 0 && ` · ${cast.reconnects} reconnect(s)`}
                  {cast && cast.stream_stalls > 0 && ` · ${cast.stream_stalls} stall(s)`}
                </div>
              </div>
              <Explain title="Disconnect" text="Drops the CASTv2 connection to this Chromecast. Playback on the TV stops being controlled by CastCast; the daemon keeps running.">
                <button
                  onClick={() => run("disconnect", daemon.disconnect)}
                  className="flex items-center gap-1.5 rounded border border-emerald-500/30 px-3 py-1.5 hover:bg-emerald-500/10"
                >
                  <Link2Off className="h-3.5 w-3.5" /> disconnect
                </button>
              </Explain>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="192.168.1.50"
                className="min-w-0 flex-1 rounded border border-emerald-500/25 bg-black/50 px-3 py-1.5 font-mono text-emerald-200 outline-none focus:border-emerald-500/60"
              />
              <Explain title="Connect" text="Opens a CASTv2 connection to the Chromecast at the IP address on the left (port 8009). Use the magnifier to auto-discover an IP, or type it in if mDNS discovery is blocked on your network.">
                <button
                  onClick={() => run("connect", () => daemon.connect(host))}
                  disabled={busy === "connect"}
                  className="flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {busy === "connect" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5" />
                  )}
                  connect
                </button>
              </Explain>
              <Explain title="Discover devices" text="Scans the local network (mDNS) for Chromecasts and fills in the first one it finds. Many routers block mDNS — if nothing is found, enter the device IP manually.">
                <button
                  onClick={() =>
                    run("discover", async () => {
                      const { devices } = await daemon.devices();
                      if (devices.length) setHost(devices[0].host);
                      else setNotice("No devices found — mDNS is often blocked. Enter the IP directly.");
                    })
                  }
                  className="rounded border border-emerald-500/25 px-3 py-1.5 hover:bg-emerald-500/10"
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
              </Explain>
            </div>
          )}
        </section>

        {/* transport */}
        {live && cast && (
          <section className="rounded border border-emerald-500/25 bg-black/40 p-3">
            <div className="mb-2 truncate text-emerald-200">{cast.title || "untitled"}</div>
            <Explain title="Seek" text="Tap anywhere on this bar to jump to that point in the video. The filled portion shows how far into the runtime you are.">
              <div
                className="mb-2 h-2 overflow-hidden rounded bg-emerald-500/15 cursor-pointer"
                onClick={(e) => {
                  if (!cast || !cast.duration) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const percent = (e.clientX - rect.left) / rect.width;
                  run("seek", () => daemon.seek(percent * cast.duration!));
                }}
              >
                <div
                  className="h-full bg-emerald-400 transition-all pointer-events-none"
                  style={{
                    width: `${cast.duration ? Math.min((cast.position / cast.duration) * 100, 100) : 0}%`,
                  }}
                />
              </div>
            </Explain>
            <div className="mb-3 flex justify-between font-mono text-emerald-500/60">
              <span>{formatDuration(cast.position)}</span>
              <span>{formatDuration(cast.duration)}</span>
            </div>
            <div className="flex gap-2">
              <Explain title="Play / Pause" text="Toggles playback on the Chromecast. The label reflects what the button will do next.">
                <button
                  onClick={() =>
                    run("toggle", cast.state === "paused" ? daemon.play : daemon.pause)
                  }
                  className="flex flex-1 items-center justify-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 py-2 hover:bg-emerald-500/20"
                >
                  {cast.state === "paused" ? (
                    <><Play className="h-4 w-4" /> play</>
                  ) : (
                    <><Pause className="h-4 w-4" /> pause</>
                  )}
                </button>
              </Explain>
              {(() => {
                const hasEmbeddedSubs = (cast.active_track_ids?.length || 0) > 0;
                const isSubtitlesOn = cast.has_text_tracks || hasEmbeddedSubs;
                const isYouTube = cast.source_path?.includes("/youtube/") ?? false;
                const tooltipTitle = cast.has_text_tracks
                  ? "External English subtitles are attached to this cast"
                  : hasEmbeddedSubs
                  ? "Embedded subtitles are active"
                  : isYouTube
                  ? "No subtitles embedded by yt-dlp"
                  : "Download English subtitles from OpenSubtitles";

                return (
                  <Explain
                    title="Subtitles"
                    text="Downloads matching English subtitles from OpenSubtitles and side-loads them onto the current cast. Disabled when subtitles are already active, when there is no source file, or for YouTube streams (which carry their own)."
                  >
                    <button
                      onClick={requestSubtitles}
                      disabled={!cast.source_path || busy === "subtitles" || isSubtitlesOn || isYouTube}
                      className={`flex items-center gap-1.5 rounded border px-4 py-2 hover:bg-emerald-500/10 disabled:opacity-40 ${
                        isSubtitlesOn
                          ? "border-emerald-400/60 bg-emerald-500/15 text-emerald-100"
                          : "border-emerald-500/25"
                      }`}
                      title={tooltipTitle}
                    >
                      {busy === "subtitles" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Subtitles className="h-3.5 w-3.5" />}
                      {isSubtitlesOn ? "subtitles on" : "subtitles"}
                    </button>
                  </Explain>
                );
              })()}
              <Explain title="Stop" text="Stops playback on the Chromecast and unloads the media. The connection to the device stays open.">
                <button
                  onClick={() => run("stop", daemon.stop)}
                  className="flex items-center gap-1.5 rounded border border-emerald-500/25 px-4 py-2 hover:bg-emerald-500/10"
                >
                  <Square className="h-3.5 w-3.5" /> stop
                </button>
              </Explain>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Explain title="Mute" text="Mutes or unmutes the Chromecast's audio output without changing the volume level.">
                <button
                  onClick={() => run("mute", () => daemon.mute(!cast.muted))}
                  className="text-emerald-400 hover:text-emerald-300"
                >
                  {cast.muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                </button>
              </Explain>
              <input
                type="range"
                min="0"
                max="100"
                value={(cast.volume ?? 1) * 100}
                onChange={(e) => run("volume", () => daemon.volume(parseInt(e.target.value) / 100))}
                className="flex-1 accent-emerald-500"
                title="Chromecast volume"
              />
            </div>
          </section>
        )}

        {/* conversion progress */}
        {remux && remux.state === "running" && (
          <section className="rounded border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-amber-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {remux.description}
              </div>
              <Explain title="Cancel conversion" text="Aborts the running ffmpeg remux/transcode. Any partially-written output is discarded.">
                <button
                  onClick={() => run("cancel", daemon.cancelPrepare)}
                  className="rounded border border-amber-500/30 px-2 py-1 text-xs text-amber-400 hover:bg-amber-500/20"
                >
                  Cancel
                </button>
              </Explain>
            </div>
            <div className="h-1 overflow-hidden rounded bg-amber-500/20">
              <div className="h-full bg-amber-400" style={{ width: `${remux.progress * 100}%` }} />
            </div>
            <div className="mt-1 text-right font-mono text-amber-400/70">
              {(remux.progress * 100).toFixed(1)}%
            </div>
          </section>
        )}

        {/* library */}
        <section className="rounded border border-emerald-500/20 bg-black/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-emerald-500/50 uppercase tracking-wider">Queue - Local, YouTube</span>
            <div className="flex items-center gap-2">
              <Explain title="Cast queue" text="Casts every item in this list back-to-back, starting with the one you have selected (or the top item). Each file is pre-flighted and converted if needed before it plays.">
                <button
                  onClick={castQueue}
                  disabled={!status?.device || !library.length || busy === "queue"}
                  className="flex items-center gap-1.5 rounded border border-emerald-500/30 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
                >
                  {busy === "queue" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cast className="h-3.5 w-3.5" />}
                  cast queue
                </button>
              </Explain>
              <Explain title="Scan" text="Re-reads your media folder and refreshes this list, the Amazon queue, and the trash. Drag rows to reorder them for the current session (order is not saved on the daemon).">
                <button
                  onClick={loadLibrary}
                  className="flex items-center gap-1.5 text-emerald-400/70 hover:text-emerald-300"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy === "library" ? "animate-spin" : ""}`} />
                  scan
                </button>
              </Explain>
            </div>
          </div>

          {library.length === 0 ? (
            <div className="py-4 text-center text-emerald-500/40">
              no files loaded — tap scan
            </div>
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {library.map((item, idx) => (
                <div
                  key={item.path}
                  draggable={true}
                  onDragStart={(e) => handleDragStart(e, idx, 'library')}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, idx, 'library')}
                  onClick={() => select(item)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left cursor-pointer hover:bg-emerald-500/10 ${
                    selected?.path === item.path ? "bg-emerald-500/15" : ""
                  }`}
                >
                  <FileVideo className="h-3.5 w-3.5 shrink-0 text-emerald-500/50" />
                  <span className="min-w-0 flex-1 truncate text-emerald-200" title={item.rel}>{item.title || item.rel}</span>
                  <span className="shrink-0 font-mono text-emerald-500/40">
                    {formatBytes(item.size_bytes)}
                  </span>
                  <Explain title="Trash (Watched)" text="Moves this file into the trash folder (a reversible soft-delete). Use it to clear watched items; permanently remove them later from the Trash section below.">
                    <button
                      onClick={(e) => trashFile(item.path, e)}
                      className="flex items-center gap-1.5 rounded border border-emerald-500/30 px-2 py-1 text-xs hover:bg-emerald-500/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Trash (Watched)
                    </button>
                  </Explain>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Amazon account */}
        <section className="rounded border border-emerald-500/20 bg-black/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-emerald-500/50 uppercase tracking-wider">Amazon Account</span>
            <span className={`font-mono text-xs ${amazonLinked ? "text-emerald-400" : "text-emerald-500/40"}`}>
              {amazonLinked ? "linked" : "not linked"}
            </span>
          </div>

          {amazonLinked ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-emerald-300">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Prime Video is linked on the daemon.
              </div>
              <Explain title="Unlink" text="Forgets that this app linked an Amazon account (a UI-side flag). It does not delete the tokens stored on the daemon; re-link or re-inject to refresh them.">
                <button
                  onClick={unlinkAmazon}
                  className="rounded border border-emerald-500/25 px-3 py-1 text-xs text-emerald-500/70 hover:bg-emerald-500/10"
                >
                  unlink
                </button>
              </Explain>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-emerald-500/70">
                Link your Amazon account so the daemon can play Prime Video titles you share to CastCast.
              </p>
              <Explain
                title="Link Amazon Account"
                text="Starts Amazon's device-code login. We ask Amazon for a short code; you open amazon.com/code on any device, sign in, and enter it. CastCast then detects the approval automatically and stores the login token on the daemon."
              >
                <button
                  onClick={startAmazonLink}
                  className="flex items-center gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-emerald-200 hover:bg-emerald-500/20"
                >
                  <LogIn className="h-4 w-4" /> Link Amazon Account
                </button>
              </Explain>

              {amazonAuthData?.public_code && (
                <div className="rounded border border-emerald-500/25 bg-black/50 p-3">
                  <div className="text-xs text-emerald-500/60">1. Go to</div>
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-emerald-300">amazon.com/code</code>
                  </div>
                  <div className="mt-2 text-xs text-emerald-500/60">2. Enter this code</div>
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-lg tracking-widest text-emerald-200">{amazonAuthData.public_code}</code>
                    <button
                      onClick={() => copyText(amazonAuthData.public_code)}
                      className="text-emerald-500/50 hover:text-emerald-300"
                      title="copy code"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              {amazonStatus && (
                <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-sm text-amber-300">
                  {amazonStatus}
                </div>
              )}

              <div>
                <button
                  onClick={() => setAmazonAdvancedOpen((v) => !v)}
                  className="flex items-center gap-1 text-xs text-emerald-500/60 hover:text-emerald-300"
                >
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${amazonAdvancedOpen ? "rotate-180" : ""}`} />
                  Advanced: paste tokens
                </button>
                {amazonAdvancedOpen && (
                  <div className="mt-2 space-y-2">
                    <Explain
                      title="Paste tokens"
                      text="For advanced users: paste the raw contents of an existing amazon_auth.json (bearer/refresh tokens). The daemon writes it to ~/.config/castcast/amazon_auth.json, linking the account without the code flow."
                    >
                      <textarea
                        value={amazonTokensText}
                        onChange={(e) => setAmazonTokensText(e.target.value)}
                        placeholder='{ "tokens": { "bearer": { ... } } }'
                        rows={4}
                        className="w-full rounded border border-emerald-500/25 bg-black/50 px-3 py-2 font-mono text-xs text-emerald-200 outline-none focus:border-emerald-500/60"
                      />
                    </Explain>
                    <button
                      onClick={injectAmazonTokens}
                      disabled={!amazonTokensText.trim()}
                      className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
                    >
                      Inject tokens
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Amazon Queue */}
        <section className="rounded border border-emerald-500/20 bg-black/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-emerald-500/50 uppercase tracking-wider">Queue - Amazon</span>
            {amazonQueue.length > 0 && (
              <Explain title="Clear Amazon queue" text="Removes every item from the Amazon watch queue on the daemon. This does not affect your Prime Video account.">
                <button
                  onClick={() => {
                    setAmazonQueue([]);
                    daemon.reorderAmazonQueue([]).catch(console.error);
                  }}
                  className="text-xs text-emerald-500/50 hover:text-red-400"
                >
                  clear
                </button>
              </Explain>
            )}
          </div>

          {amazonQueue.length === 0 ? (
            <div className="py-4 text-center text-emerald-500/40">
              amazon queue is empty
            </div>
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {amazonQueue.map((item, idx) => (
                <div
                  key={item.url || idx}
                  draggable={true}
                  onDragStart={(e) => handleDragStart(e, idx, 'amazon')}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, idx, 'amazon')}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left cursor-pointer hover:bg-emerald-500/10`}
                  onClick={() => {
                     // Optionally cast the amazon url
                     daemon.cast(item.url, true, undefined, undefined, item.title).catch(e => setNotice(String(e)));
                  }}
                >
                  <FileVideo className="h-3.5 w-3.5 shrink-0 text-emerald-500/50" />
                  <span className="min-w-0 flex-1 truncate text-emerald-200">{item.title || item.url}</span>
                  <Explain title="Remove from queue" text="Removes just this title from the Amazon queue on the daemon.">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeAmazonItem(idx);
                      }}
                      className="p-1 hover:bg-emerald-500/20 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-emerald-500/50 hover:text-red-400" />
                    </button>
                  </Explain>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Trash */}
        <section className="rounded border border-emerald-500/20 bg-black/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-emerald-500/50 uppercase tracking-wider">Trash</span>
            <Explain title="Empty trash" text="Permanently deletes every file currently in the trash from disk. This cannot be undone.">
              <button
                onClick={emptyTrash}
                disabled={!trashItems.length || busy === "empty-trash"}
                className="flex items-center gap-1.5 rounded border border-rose-500/30 px-2 py-1 text-xs text-rose-400 hover:bg-rose-500/20 disabled:opacity-40"
              >
                {busy === "empty-trash" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                empty trash
              </button>
            </Explain>
          </div>

          {trashItems.length === 0 ? (
            <div className="py-4 text-center text-emerald-500/40">
              trash is empty
            </div>
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {trashItems.map((item) => (
                <div
                  key={item.path}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left bg-emerald-500/5"
                >
                  <FileVideo className="h-3.5 w-3.5 shrink-0 text-emerald-500/50" />
                  <span className="min-w-0 flex-1 truncate text-emerald-200 line-through opacity-70">{item.rel}</span>
                  <span className="shrink-0 font-mono text-emerald-500/40">
                    {formatBytes(item.size_bytes)}
                  </span>
                  <Explain title="Permanently delete" text="Deletes this file from disk immediately. This cannot be undone.">
                    <button
                      onClick={(e) => deleteFile(item.path, e)}
                      className="flex items-center gap-1.5 rounded border border-rose-500/30 px-2 py-1 text-xs text-rose-400 hover:bg-rose-500/20"
                    >
                      Permanently Delete
                    </button>
                  </Explain>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* pre-flight */}
        {selected && (
          <section className="space-y-3">
            <div className="text-emerald-500/50 uppercase tracking-wider">pre-flight</div>
            {busy === "preflight" && !report ? (
              <div className="flex items-center gap-2 py-4 text-emerald-500/50">
                <Loader2 className="h-4 w-4 animate-spin" /> probing…
              </div>
            ) : (
              report && <PreflightPanel
                report={report}
                selectedAudioId={selectedAudioId}
                setSelectedAudioId={setSelectedAudioId}
                selectedSubtitleId={selectedSubtitleId}
                setSelectedSubtitleId={setSelectedSubtitleId}
              />
            )}

            <div className="flex gap-2">
              <Explain title="Cast" text="Sends this file to the connected Chromecast. If it needs conversion, the daemon prepares it first (see Auto-prepare in Advanced). Audio/subtitle track choices and any Advanced/DRM fields are applied.">
                <button
                  onClick={() => doCast(false)}
                  disabled={!status?.device || busy === "cast"}
                  className="flex flex-1 items-center justify-center gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 py-2.5 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
                >
                  {busy === "cast" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Cast className="h-4 w-4" />
                  )}
                  cast
                </button>
              </Explain>
              {report?.plan && (
                <Explain title="Convert" text={report.plan.description || "Remuxes/transcodes this file into a Chromecast-compatible form using ffmpeg. Runs on the phone; progress shows above."}>
                  <button
                    onClick={() =>
                      selected && run("prepare", () => daemon.prepare(selected.path))
                    }
                    disabled={remux?.state === "running"}
                    className="rounded border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40"
                    title={report.plan.description}
                  >
                    convert
                  </button>
                </Explain>
              )}
              {report?.remaster_plan && (
                <Explain title="4K Remaster" text={report.remaster_plan.description || "Upscales/repackages this file toward 4K for the Chromecast Ultra. This is a heavy ffmpeg job and can take a while."}>
                  <button
                    onClick={() =>
                      selected && run("remaster", () => daemon.remaster(selected.path))
                    }
                    disabled={remux?.state === "running"}
                    className="rounded border border-blue-500/40 bg-blue-500/10 px-4 py-2.5 text-blue-300 hover:bg-blue-500/20 disabled:opacity-40 font-bold tracking-wide"
                    title={report.remaster_plan.description}
                  >
                    4K Remaster
                  </button>
                </Explain>
              )}
            </div>

            {/* advanced / DRM cast options */}
            <div className="rounded border border-emerald-500/15 bg-black/30 p-2">
              <button
                onClick={() => setAdvancedCastOpen((v) => !v)}
                className="flex w-full items-center gap-1 text-xs text-emerald-500/60 hover:text-emerald-300"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advancedCastOpen ? "rotate-180" : ""}`} />
                Advanced
              </button>
              {advancedCastOpen && (
                <div className="mt-2 space-y-2">
                  <Explain title="Auto-prepare" text="When on, casting a file that is not already compatible will start the conversion automatically instead of just warning you. Turn off to require an explicit Convert.">
                    <label className="flex items-center gap-2 text-sm text-emerald-300">
                      <input
                        type="checkbox"
                        checked={autoPrepare}
                        onChange={(e) => setAutoPrepare(e.target.checked)}
                        className="accent-emerald-500"
                      />
                      Auto-prepare incompatible files before casting
                    </label>
                  </Explain>
                  <Explain title="License URL" text="Optional DRM license (Widevine/PlayReady) server URL for protected streams. Leave blank for normal, unprotected media.">
                    <input
                      value={drmLicenseUrl}
                      onChange={(e) => setDrmLicenseUrl(e.target.value)}
                      placeholder="DRM license URL (optional)"
                      className="w-full rounded border border-emerald-500/25 bg-black/50 px-3 py-1.5 font-mono text-xs text-emerald-200 outline-none focus:border-emerald-500/60"
                    />
                  </Explain>
                  <Explain title="Offline DRM token" text="Optional pre-acquired offline DRM token for protected content, passed straight to the daemon. Leave blank unless you know you need it.">
                    <input
                      value={drmToken}
                      onChange={(e) => setDrmToken(e.target.value)}
                      placeholder="Offline DRM token (optional)"
                      className="w-full rounded border border-emerald-500/25 bg-black/50 px-3 py-1.5 font-mono text-xs text-emerald-200 outline-none focus:border-emerald-500/60"
                    />
                  </Explain>
                </div>
              )}
            </div>
          </section>
        )}

        {/* log */}
        <section className="rounded border border-emerald-500/20 bg-black/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-emerald-500/50 uppercase tracking-wider">daemon log</span>
            <div className="flex gap-2">
              <Explain title="Maximum Verbosity" text="Pulls the daemon's full diagnostic dump — the recent log buffer, the last error, and the raw audit log file — into a modal. Use this when reporting a bug.">
                <button
                  onClick={async () => {
                    try {
                      const text = await daemon.getDiagnosticsLogs();
                      setMaxVerbosityLogs(text);
                    } catch (e) {
                      setNotice("Failed to fetch diagnostics logs");
                    }
                  }}
                  className="rounded border border-blue-500/30 px-2 py-1 text-xs text-blue-400/70 hover:bg-blue-500/10"
                >
                  Maximum Verbosity
                </button>
              </Explain>
              <Explain title="Debug log lines" text="Shows or hides low-level debug entries in the live log below. Info and warnings are always shown.">
                <button
                  onClick={() => setShowDebugLogs((value) => !value)}
                  className="rounded border border-emerald-500/25 px-2 py-1 text-xs text-emerald-400/70 hover:bg-emerald-500/10"
                >
                  {showDebugLogs ? "hide debug" : "show debug"}
                </button>
              </Explain>
              <Explain title="Kill server" text="Tells the daemon to shut down and returns you to the launch screen. You will need to relaunch it from Termux to cast again.">
                <button
                  onClick={() => {
                    // Tear down SSE and poll FIRST so they can't bounce us back online
                    if (unsubscribeRef.current) {
                      unsubscribeRef.current();
                      unsubscribeRef.current = null;
                    }
                    if (pollTimerRef.current !== null) {
                      window.clearInterval(pollTimerRef.current);
                      pollTimerRef.current = null;
                    }
                    daemon.shutdown().catch(() => {});
                    setOnline(false);
                    setStatus(null);
                  }}
                  className="flex items-center gap-1.5 rounded border border-rose-500/30 px-2 py-1 text-xs text-rose-400 hover:bg-rose-500/10"
                >
                  <Power className="h-3 w-3" /> kill server
                </button>
              </Explain>
            </div>
          </div>
          <div
            ref={logRef}
            className="max-h-48 space-y-0.5 overflow-y-auto font-mono"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            {logs.length === 0 ? (
              <div className="text-emerald-500/30">waiting for events…</div>
            ) : (
              logs.filter((line) => showDebugLogs || line.level !== "debug").map((line) => (
                <div
                  key={line.seq}
                  className={
                    line.level === "warn"
                      ? "text-amber-400/80"
                      : line.level === "debug"
                        ? "text-emerald-500/35"
                        : "text-emerald-400/70"
                  }
                >
                  <span className="text-emerald-500/30">
                    {new Date(line.ts * 1000).toLocaleTimeString([], { hour12: false })}{" "}
                  </span>
                  {line.message}
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Floating Remote FAB */}
      {live && cast && (
        <Drawer>
          <Explain title="Remote Control" text="Opens a full-screen remote with a large play/pause, ±10-second skip, volume, mute, and stop — handy when the phone is across the room.">
            <DrawerTrigger asChild>
              <button className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-[#050807] shadow-[0_0_15px_rgba(16,185,129,0.3)] transition-transform hover:scale-105 active:scale-95">
                <Gamepad2 className="h-6 w-6" />
              </button>
            </DrawerTrigger>
          </Explain>
          <DrawerContent className="border-emerald-500/20 bg-[#0a100d] text-emerald-300 font-sans">
            <DrawerHeader>
              <DrawerTitle className="text-emerald-400">Remote Control</DrawerTitle>
              <DrawerDescription className="truncate text-emerald-500/60">
                {cast.title || "Now Playing"}
              </DrawerDescription>
            </DrawerHeader>
            <div className="p-6 pt-0 space-y-8">
              {/* Media Progress */}
              <div className="space-y-3">
                <div
                  className="h-3 overflow-hidden rounded-full bg-emerald-500/15 cursor-pointer"
                  onClick={(e) => {
                    if (!cast || !cast.duration) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const percent = (e.clientX - rect.left) / rect.width;
                    run("seek", () => daemon.seek(percent * cast.duration!));
                  }}
                >
                  <div
                    className="h-full bg-emerald-400 transition-all pointer-events-none"
                    style={{
                      width: `${cast.duration ? Math.min((cast.position / cast.duration) * 100, 100) : 0}%`,
                    }}
                  />
                </div>
                <div className="flex justify-between font-mono text-sm text-emerald-500/60">
                  <span>{formatDuration(cast.position)}</span>
                  <span>{formatDuration(cast.duration)}</span>
                </div>
              </div>

              {/* Transport Controls */}
              <div className="flex items-center justify-center gap-8">
                <Explain title="Rewind 10s" text="Jumps back ten seconds in the current video.">
                  <button
                    onClick={() => run("seek-back", () => daemon.seek(Math.max(0, cast.position - 10)))}
                    className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 active:scale-95"
                  >
                    <Rewind className="h-6 w-6" />
                  </button>
                </Explain>

                <Explain title="Play / Pause" text="Toggles playback on the Chromecast.">
                  <button
                    onClick={() => run("toggle", cast.state === "paused" ? daemon.play : daemon.pause)}
                    className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 text-[#050807] hover:bg-emerald-400 active:scale-95"
                  >
                    {cast.state === "paused" ? (
                      <Play className="h-10 w-10 ml-1" />
                    ) : (
                      <Pause className="h-10 w-10" />
                    )}
                  </button>
                </Explain>

                <Explain title="Forward 10s" text="Jumps forward ten seconds in the current video.">
                  <button
                    onClick={() => run("seek-forward", () => daemon.seek(Math.min(cast.duration || 0, cast.position + 10)))}
                    className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 active:scale-95"
                  >
                    <FastForward className="h-6 w-6" />
                  </button>
                </Explain>
              </div>

              {/* Volume & Stop */}
              <div className="flex items-center gap-4 pb-4">
                <Explain title="Mute" text="Mutes or unmutes the Chromecast.">
                  <button
                    onClick={() => run("mute", () => daemon.mute(!cast.muted))}
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 active:scale-95"
                  >
                    {cast.muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                  </button>
                </Explain>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={(cast.volume ?? 1) * 100}
                  onChange={(e) => run("volume", () => daemon.volume(parseInt(e.target.value) / 100))}
                  className="flex-1 accent-emerald-500"
                  title="Chromecast volume"
                />
                <Explain title="Stop" text="Stops playback and unloads the media on the Chromecast.">
                  <button
                    onClick={() => run("stop", daemon.stop)}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 active:scale-95"
                  >
                    <Square className="h-4 w-4" />
                  </button>
                </Explain>
              </div>
            </div>
          </DrawerContent>
        </Drawer>
      )}

      {/* Gamified Telemetry Modal */}
      {anomaly && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-amber-500/50 bg-[#0a100d] p-6 shadow-[0_0_30px_rgba(245,158,11,0.15)]">
            <div className="mb-4 flex items-center gap-3 text-amber-400">
              <CircleAlert className="h-8 w-8" />
              <h2 className="text-xl font-bold tracking-wide">Rare Anomaly Discovered!</h2>
            </div>
            <div className="mb-6 space-y-3 text-sm text-emerald-100/80">
              <p>
                You've stumbled upon a highly complex streaming architecture at <span className="font-mono text-amber-300">{anomaly.domain}</span> that our engine hasn't seen before.
              </p>
              <p>
                We have captured a diagnostic signature. Would you like to submit this to the developers and get credited as a Contributor?
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => {
                  const issueTitle = encodeURIComponent(`Anomaly Report: ${anomaly.domain}`);
                  const issueBody = encodeURIComponent(`I encountered an anomaly while casting.\n\n\`\`\`json\n${JSON.stringify(anomaly, null, 2)}\n\`\`\`\n\n_Submitted via CastCast Telemetry Engine_`);
                  window.open(`https://github.com/1456319/openchromecast/issues/new?title=${issueTitle}&body=${issueBody}`, "_blank");
                  setAnomaly(null);
                }}
                className="rounded-lg border border-amber-500/50 bg-amber-500/20 py-3 font-bold text-amber-300 transition-colors hover:bg-amber-500/30"
              >
                Submit & Claim Credit
              </button>
              <button
                onClick={() => setAnomaly(null)}
                className="rounded-lg border border-emerald-500/20 px-4 py-3 text-emerald-500/60 hover:bg-emerald-500/10"
              >
                Ignore
              </button>
            </div>
          </div>
        </div>
      )}

      {maxVerbosityLogs !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl border border-blue-500/50 bg-[#0a100d] p-6 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
            <div className="mb-4 flex items-center justify-between text-blue-400">
              <h2 className="text-xl font-bold tracking-wide">Maximum Verbosity Diagnostics</h2>
              <button
                onClick={() => setMaxVerbosityLogs(null)}
                className="text-blue-500/60 hover:text-blue-400"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-auto rounded bg-black/60 p-4 font-mono text-sm text-blue-300/80">
              <pre className="whitespace-pre-wrap">{maxVerbosityLogs}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
    </LongPressHelpProvider>
  );
}
