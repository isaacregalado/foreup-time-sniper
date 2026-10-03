# Synthetic hold — win the race with ForeUp's own click handler

**Goal:** any in-window slot (6:30–8:00am, Red/Green) at the 7pm drop. Tonight's live run
(2026-07-12) proved the browser-native tile click loses structurally: first hold attempt at
T+2.4s (render-bound), whole Red morning gone in <12s; candidates 2–3 burned 8s each waiting
for tiles that were already gone server-side.

## Root causes found in ForeUp's bundle (v19.0.13, deminified)

1. `TimeView` binds `{'click':'viewTime'}`. **`viewTime()` never reads the DOM** — it clones
   `this.model.attributes`, overrides `players`/`holes` from `App.data.filters`, POSTs
   `pending_reservation` (sync `$.ajax`), then `pending_reservation_obj.store()` +
   `new BookTimeView({model}).show()`. The tile is just a click target.
2. Tonight's "click swallowed": `viewTime` has no refresh guard, so the dead tile was a
   **detached element** — our own 800ms pre-fire refresh re-rendered the list and Playwright
   clicked an orphaned node with no Backbone handler. Self-inflicted.
3. `TimeView`, `BookTimeView`, `Reservation`, `pending_reservation_obj`, `Backbone`, `App` are
   all `var`-declared → reachable as `window.*` from `page.evaluate` (probed live 2026-07-12).

## Design

**Primary hold path (`holdViaSynth`)**: at API detection, build the model attributes from the
raw `ApiTime` (same endpoint that fills the page's own collection) + explicit
`course_id/schedule_id/booking_class_id/holes`, then in the staged page:
`new TimeView({model: new Backbone.Model(attrs)}).viewTime()`. ForeUp's own code fires the
hold POST with the session cookies, stores the pending reservation, and pops the BookTimeView
modal natively. Expected hold-landed time: **~T+1.0–1.3s** (detect 0.64s + one POST RTT), vs
T+2.4s minimum for the tile path. On rejection ("Time not available"), next candidate is ~1
RTT away instead of 8s.

- Success/failure read exactly like the tile path: `page.waitForResponse` on the same POST.
- `synth_error` (classes missing / evaluate throws — i.e., ForeUp shipped new code) falls back
  to the tile-click path, which keeps its dead-tile fast-fail. Rejections do NOT fall back —
  a rejected slot is gone; move to the next candidate.
- `--no-synth` flag / `SYNTH=0` kills the new path entirely (pure fallback mode).

**Everything after the hold is unchanged** (already $0- and live-verified): modal money gates
(text, in-modal players click, Backbone model check, Pay-at-Facility radio, iframe $ amount),
IMAP code, card pre-fill, `--auto-book`.

**Removed:** the 800ms pre-fire sheet refresh (caused detached tiles; synth path needs no
rendered tiles; the tile fallback already does its own `fireDateChange` retries).

**Preflight:** add `viewTime`, `createPending`, `TimeView` to FLOW_MARKERS so a ForeUp change
turns into a systems-check alarm, not a race-night surprise.

**Money safety unchanged:** the synthetic path only creates the same $0 pending hold a human
click creates (expires ~5min, $0); every charging step still sits behind the five gates.
Vulture and candidate-walk retry limits unchanged. Scope line unchanged: Isaac's single
account, no evasion, deliberate testing only (holds are soft-rate-limited).

## Test plan

1. Unit: attrs builder (per-course IDs, holes, ApiTime pass-through) + FLOW_MARKERS present in
   live bundle (preflight covers at runtime). Full suite + typecheck.
2. **$0 live verify (one deliberate hold):** `--no-book --course red --date 07-19-2026
   --from 12:00 --to 17:00` against the 07-19 afternoon leftovers → synth hold lands → modal
   verified (course/date/time/players) → close releases at $0. One attempt, no loops.
3. Sync VM afterward; VM re-runs its own dry-run (preflight validates markers from Oregon).

## Additions (same evening)

- **Holes landmine fixed:** the page's holes filter defaults to "Both" → `holes=all` in the
  hold POST → "Invalid request" (server needs concrete holes). `stagePage` now clicks the
  "18" chip and verifies `filters.holes`. This also affected the old tile path.
- **Model class matters:** synthetic model must be `App.data.times.model` (or `Reservation`)
  — bare `Backbone.Model` lacks defaults (`carts`, `duration`) → params missing → rejected.
- **Hot path shaved:** IMAP `resetBaseline` moved out of the hold path (once pre-drop +
  non-blocking after closeModal); `bringToFront` no longer awaited; T-3.5s same-origin fetch
  from each page re-warms its connection pool for the hold POST.
- **Parallel cross-course race:** each course walks its own ranked candidates serially on its
  own staged page; courses race concurrently (two concurrent pendings verified live
  2026-07-06). First confirmed hold freezes all walks; same-instant second hold is compared
  (better slot kept) and the loser released at $0. Exactly one hold reaches completeBooking.
- **Rate limit learned:** "Invalid request" is ALSO the soft-rate-limit response — 9 hold
  attempts in 5 min tripped it. Test with `--candidates 1`, one attempt per cooldown.

## Rollout

Next real drop: Sun 2026-07-19 19:00 ET (books 07-26). Synth primary + tile fallback + vulture,
courses raced in parallel. Expected first hold attempt ~T+0.5s, candidate walk ~330ms/step,
both courses covered simultaneously.
