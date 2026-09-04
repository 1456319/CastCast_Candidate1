# CastCast — UI completeness, splash consistency & long-press help

## Context

CastCast (`github.com/1456319/CastCast`) is a Capacitor Android app whose React
UI is a thin face for a Python "castcast" daemon running in Termux. The daemon
speaks CASTv2 to a Chromecast; the UI talks to it over `http://127.0.0.1:8765`
(REST + SSE). The Chromecast/daemon path is finicky, so **this work touches the
UI layer only** — no Python daemon logic changes.

Analysis of the daemon's HTTP surface (`daemon/castcast/api.py`) against the UI
client (`src/app/lib/daemon.ts`) and call sites (`src/app/App.tsx`) found several
**orphan capabilities**: daemon endpoints that exist but have no reachable UI.
The goal is: (1) no orphan functions — every daemon capability is reachable from
a sleek, consistent UI; (2) a consistent, correctly-gated splash/offline screen;
(3) new reactive/informational UI (a readiness dashboard); and (4) long-press-to-
explain on essentially every control, plus a hint telling users the gesture
exists.

**Delivery:** a feature branch + pull request on `1456319/CastCast` via the
GitHub API. **Styling:** keep the existing terminal-green (`#050807` /
`emerald-*`) identity; all new elements match it — no redesign.

Note: `api.py`, `daemon.ts`, `App.tsx`, `health.py` carry a "synchronization-map"
header (`docs/SYNCHRONIZATION_MAP.md`). We only add **frontend wrappers for
routes that already exist** in `api.py`, which keeps the API contract in sync
(it fills in the missing "Frontend Wrapper" column rather than changing it). No
daemon route or schema is added or altered.

## Orphan inventory (from api.py) and disposition

| Daemon capability | Status | Action |
|---|---|---|
| `GET /health` (`svc.health()`) | orphan | Add wrapper + Readiness dashboard UI |
| `GET /amazon/auth` (`create_code_pair`) | orphan | Add wrapper + Amazon login flow |
| `GET /amazon/poll` (`poll_register`) | orphan | Add wrapper + poll loop in login flow |
| `POST /amazon/inject` | orphan | Add wrapper + "paste tokens" manual fallback |
| `POST /amazon/queue/remove` `{index}` | orphan | Add wrapper; use for Amazon row removal |
| `/cast` `license_url`,`offline_drm_token`,`auto_prepare` | orphan params | Add to `cast()` + Advanced disclosure in pre-flight |
| `POST /library/reorder` via `daemon.reorderLibrary` | phantom (no daemon route) | Remove dead client method + commented call |
| `GET /logs?since=` | redundant (SSE covers it) | Leave as-is (per decision) |

## Files to modify (all UI-layer)

1. **`src/app/lib/daemon.ts`** — add typed wrappers for existing routes:
   - `health(): Promise<HealthReport>` → `GET /health` (types: `Check`,
     `HealthReport` mirroring `health.py` — `key,label,ok,detail,remedy,blocking`
     and `ready,version,python,serve_command,checks[],blocking[]`).
   - `amazonAuth()` → `GET /amazon/auth`; `amazonPoll(pub, priv)` →
     `GET /amazon/poll?public_code=&private_code=`; `injectAmazon(tokens)` →
     `POST /amazon/inject`; `removeAmazonQueue(index)` → `POST /amazon/queue/remove`.
   - Extend `cast()` signature with optional `licenseUrl?`, `offlineDrmToken?`,
     `autoPrepare?` → passed as `license_url`, `offline_drm_token`, `auto_prepare`.
   - **Remove** `reorderLibrary` (phantom — no `/library/reorder` route exists).

2. **`src/app/components/long-press-help.tsx`** (new) — reusable long-press
   explanation primitive matching the terminal aesthetic:
   - `useLongPress(onLongPress, {delay:500})` hook handling
     `pointerdown/up/leave/cancel` (works for touch + mouse), cancels on move,
     and suppresses the subsequent click when a long-press fired.
   - `<Explain text="…">{children}</Explain>` wrapper: renders children, and on
     long-press shows the explanation in a shared bottom-sheet/popover styled
     like the existing modals (`border-emerald-500/40 bg-[#0a100d]`). A single
     app-level overlay driven by context avoids per-element popover cost.
   - Keep the existing `title=` attributes as desktop-hover fallback.

3. **`src/app/App.tsx`** — the bulk of the work:
   - **Splash/offline consistency:** the `if (!online)` gate is the de-facto
     splash. Confirm the primary button reads **"Launch Daemon (Termux)"** and
     renders **only** when `!online` (already true). Fixes: stop leaking stale
     `notice` into the splash banner when it belongs to the main screen (scope
     the amber banner to launch/gate messages), and ensure a single consistent
     status line + button state. Optionally add the `/health` readiness summary
     to the gate so first-launch users see exactly what's blocking casting
     (health remedies are copy-paste commands like `pkg install ffmpeg`).
   - **Readiness dashboard (new reactive UI):** a collapsible section (and a
     compact summary chip in the header) driven by `daemon.health()`, refreshed
     on mount / reconnect / manual refresh. Render each `check` as a row with
     ok/warn/unknown tone (green/amber/`?`), `detail`, and a copyable `remedy`.
     Reuses existing card styling.
   - **Amazon account section (new):** "Link Amazon Account" button →
     `amazonAuth()`; show returned `public_code` + instruction to visit
     `amazon.com/code`; poll `amazonPoll(public_code, private_code)` on an
     interval until `response.success` / error / timeout, with clear status.
     Include an "Advanced: paste tokens JSON" disclosure → `injectAmazon()`.
     Show linked/unlinked state.
   - **Amazon queue removal:** switch per-row remove and "clear" to use
     `removeAmazonQueue(index)` (falls back to existing `reorderAmazonQueue`
     only if needed), so the dedicated endpoint is exercised.
   - **Advanced cast disclosure:** in the pre-flight action area, an "Advanced"
     `<details>` with `License URL` + `Offline DRM token` inputs and an
     `auto_prepare` toggle; `doCast` passes them through the extended `cast()`.
   - **Library reorder cleanup:** remove the commented `reorderLibrary` call;
     keep drag reorder as local-only visual (no daemon route exists) with an
     `<Explain>` note that local queue order is session-only.
   - **Long-press everywhere:** wrap the meaningful controls (launch, connect,
     discover, cast, cast queue, convert, 4K remaster, subtitles, transport,
     mute/volume, trash/delete/empty, kill server, max verbosity, discovery
     mode, Amazon link, health rows, FAB) in `<Explain text="…">`. Add a small
     one-time dismissible hint near the header: "Tip: long-press any control for
     an explanation." Persist dismissal in `localStorage`.

4. **`src/app/components/preflight-panel.tsx`** — only if the Advanced cast
   fields live inside the panel; otherwise keep the fields in `App.tsx`'s action
   area and leave this file untouched.

## Aesthetic

Before writing UI, invoke the `aesthetic-stance` skill (full-app UI work). Since
the user chose "keep styling as-is," treat the existing terminal-green system as
the committed stance: `bg-[#050807]`, `text-emerald-300/400/500` at opacities,
amber warnings, rose destructive, blue diagnostics; `'Exo 2'` body / `'JetBrains
Mono'` mono; bordered translucent cards (`rounded border border-emerald-500/20
bg-black/40`); lucide icons. New sections must be visually indistinguishable in
system from existing ones. No new palette, no token-file changes.

## Verification

- Type-check the frontend (`tsc` / the project's build) to confirm the new
  `daemon.ts` types and `App.tsx` usage compile; ensure no dangling
  `reorderLibrary` references remain (grep).
- Manual/logic review of gating: `!online` renders splash with the launch
  button and nothing from the main screen; going online hides it.
- Since a live Chromecast + Termux daemon isn't available in this environment,
  validate wiring by confirming every new control maps to a real `api.py` route
  and payload shape (cross-check against the route table above). Note in the PR
  that on-device smoke testing (Amazon pairing, health remedies, long-press on
  touch) should be done by the maintainer.
- Long-press: verify the hook fires on both `pointer` (touch) and mouse, cancels
  on move/scroll, and suppresses the click-through so long-press doesn't also
  trigger the control's action.

## Out of scope

No changes to any Python daemon logic, CASTv2/receiver, native Capacitor
plugins, or `/library/reorder` (nonexistent). `/logs?since=` intentionally left
unbound (SSE is the live source).
