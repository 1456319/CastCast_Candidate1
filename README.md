## What is CastCast

CastCast turns any Android phone into a full Chromecast control head — no
Google Home, no account sign-in wall, no cloud round-trip. A small local daemon
runs on the phone in Termux and speaks the raw CASTv2 protocol directly to your
TV over your LAN; the app is a fast, offline-first face for it.

What sets it apart:

- **It casts what other apps refuse to.** Local files are pre-flighted with
  ffprobe and transcoded on-device only when the TV actually needs it, so you
  are not re-encoding video for no reason. A dedicated 4K remaster path targets
  the Chromecast Ultra.
- **It reaches streams the sender apps hide.** A built-in discovery browser
  detects HLS/DASH manifests and DRM streams on a page and hands them to the
  daemon to cast — including Prime Video, once your Amazon account is linked.
- **It stays on your network.** All device control happens over localhost to a
  daemon on the same phone; nothing about your library or playback leaves the
  LAN.
- **It explains itself.** Casting is full of dense concepts (remux vs. remaster,
  DRM license URLs, auto-prepare). Rather than bury the UI in help text,
  long-pressing almost any control opens a plain-language explanation of exactly
  what it does.

## Installation (as automated as possible)

The goal is one tap to a working cast. The offline/splash screen drives it:

1. Install the APK.
2. Open CastCast and tap **Launch Daemon (Termux)**. This sends Termux a
   RUN_COMMAND intent that installs and starts the daemon for you; the app then
   waits for it to come online and connects automatically.
3. Cast.

The only unavoidable manual steps are the ones the platform forces:

- Termux must be installed and must have granted RUN_COMMAND permission (a
  one-time Android prompt). If the intent cannot fire, the splash shows a single
  copy-paste fallback command.
- Linking Amazon requires you to approve a code at amazon.com/code once — the
  app generates the code, shows it, and detects approval automatically.

Every other prerequisite is surfaced, not assumed: the new **Readiness
dashboard** checks the media server binding, LAN address, ffmpeg/ffprobe, and
storage access, and for anything missing it shows a one-line remedy you can copy
straight into Termux.

## What this PR changes (UI layer only)

No Python daemon logic, CASTv2 code, or native plugin is touched — the
Chromecast path is intentionally left alone. This PR binds daemon capabilities
that already existed but had no reachable UI, and adds informational surfaces
around them. All new elements match the existing terminal-green system.

**`src/app/lib/daemon.ts`** — typed frontend wrappers for existing daemon
routes: `health()`, `amazonAuth()`, `amazonPoll()`, `injectAmazon()`,
`removeAmazonQueue(index)`; new `HealthCheck` / `HealthReport` / `CastOptions`
types mirroring `health.py`; `cast()` extended with optional `license_url`,
`offline_drm_token`, and `auto_prepare` (omitted unless set, so an ordinary cast
serializes exactly as before). Removed the phantom `reorderLibrary` method (no
such route exists).

**`src/app/components/long-press-help.tsx`** (new) — a long-press-to-explain
primitive: `LongPressHelpProvider`, `useExplain()`, and `<Explain text="...">`.
Attaches pointer handlers to a single child with no extra DOM node, fires at
450 ms, cancels on movement or scroll, suppresses the trailing click so the
control does not also activate, and keeps the desktop hover tooltip as a
fallback.

**`src/app/App.tsx`**
- Splash/offline gate corrected: the banner now shows only daemon/setup
  messages (no stale main-screen text leaks in), the primary button reads
  **Launch Daemon (Termux)** and renders only while offline.
- New **Readiness dashboard**: a header status chip plus a collapsible panel
  driven by `/health`, refreshed on mount, reconnect, and manual refresh, with
  per-check pass/warn/unknown state, detail, and copyable remedies.
- New **Amazon Account** section: device-code linking end to end (request code
  → show it with the amazon.com/code instruction → auto-poll until approved),
  plus an advanced paste-tokens fallback; linked state is remembered.
- Amazon queue rows now remove through the dedicated index endpoint.
- **Advanced** cast disclosure with an auto-prepare toggle and optional DRM
  license URL / offline token fields.
- Local library drag-reorder is now clearly session-only (the daemon has no
  reorder route); a one-time dismissible hint points users at the long-press
  gesture.

## Synchronization

Only frontend wrappers for routes that already exist in `api.py` were added, so
the `docs/SYNCHRONIZATION_MAP.md` contract stays in sync — the API-contract
header files were preserved and no route or schema was added or changed.

## Testing notes

Every new control maps to a verified `api.py` route and payload shape. Because a
live Chromecast and Termux daemon are not available in CI, the following need an
on-device pass before merge:

- Amazon pairing through to a successful poll.
- Readiness remedies rendering against a real `/health` payload.
- Long-press on touch: fires, cancels on scroll, and does not trigger the
  underlying control.
