# Takeover prompt — Bethpage sniper, browser-native booking

Paste everything below into a fresh session at `~/bethpage-sniper`.

---

I'm continuing my Bethpage tee-time sniper at ~/bethpage-sniper (TypeScript,
`src/turbo.ts` flagship + `src/ui-server.ts` local dashboard). Read the project
memory and `src/turbo.ts` first, then confirm state before changing code.

## Goal
Reliably win a Bethpage tee time (Red or Green, any slot 6:30–8:00am, earliest
first, fallback to closest before ~9:00), 4 players, my own single ForeUp
account. ForeUp drops times 7 days out at 7:00:00 PM ET. I run it Sunday
evenings and I AM at my computer at 7pm.

## THE TASK: finish the booking/payment step, done via ForeUp's own UI
The race/hold/detection all work. The unfinished piece is the paid step. I want
the tool to win the slot fast, then let me **definitely complete payment through
ForeUp's real browser UI** (I have a saved VISA on the account). I chose
"stop one click short": the tool fills everything and I click the final
"Book Time" myself. An `--auto-book` flag may click it automatically.

### Money-safety (hard rules)
- The ONLY thing that charges is the final "Book Time" click ($5/player,
  non-refundable, 1 booking/12h limit). Everything up to it is $0.
- A held slot with no final click expires in ~5 min at $0.
- Verify course/date/time/players match before ever reaching the pay click.
- Do NOT hammer ForeUp with repeated test-holds — each one is a real hold on my
  account and ForeUp soft-rate-limits ("Invalid request") after several, which
  could hurt a real Sunday run. Test deliberately, not in loops.

### Chosen architecture: browser-native hold (reliable over fastest)
The API race should act as a fast DETECTOR (which time/course dropped). Then the
**browser clicks that actual time-slot card**, following ForeUp's native
click → code → card → Book flow. This guarantees reaching the pay screen without
reverse-engineering ForeUp's checkout. ~0.3–0.8s slower to grab than pure-API,
which is fine: I can't out-race co-located Oregon bots for the single hottest
slot anyway, and vulture mode backs it up. Do NOT rely on the pure-API hold +
localStorage-resume bridge — I tested it and ForeUp did not reliably pop the
resume/code screen.

## What's already built and CONFIRMED (don't redo)
- Window logic 6:30–8:00am earliest-first + fallback cap (FALLBACK_UNTIL);
  race Red+Green concurrently; vulture mode (re-hunt freed slots ~7 min after
  drop); caffeinate; auto-arm scheduling; drop-offset learning; telemetry to
  `logs/race-log.jsonl`; local dashboard `npm run ui` (http://localhost:4747)
  with modes (systems check / $0 test / real) + verdict panel. 81 unit tests
  pass, `npx tsc --noEmit` clean.
- **Per-schedule booking classes** (times endpoint tolerates a wrong one, but
  the hold rejects "Invalid booking class for this schedule"). Verified IDs for
  "Verified NYS Resident - Bethpage/Sunken Meadow": black 50294, red 50295,
  blue 50293, green 50296, yellow 50297. Hardcoded per-course in turbo.ts.
- **Email code trigger is POST** to
  `/api_rest/index.php/courses/{course}/teetime/confirmation/{reservationId}/{userId}`
  (GET does not send it). IMAP retrieval via `src/email-monitor.ts` works.
- **Saved card exists** on the account (VISA …4071) via
  `/api/booking/courses/19765/users/credit_cards`.
- **`oco/bag/teetime` only fills a "bag" — it does NOT complete a fee-bearing
  booking.** The old API `book()` was a false positive and has been removed.
  Payment must go through the browser.
- `booking_fee_required: true` for Bethpage → after code, ForeUp shows a payment
  selection screen (saved card) then "Book Time".
- UA gotcha: ForeUp's WAF 403s HeadlessChrome — a real Chrome UA is pinned.
  Use `waitUntil: 'domcontentloaded'` (networkidle never fires). Stale sessions
  fail silently (login modal only appears after clicking a protected class);
  bootstrap already retries login around the class click.

## Browser-native flow — LIVE-MAPPED 2026-07-08 ($0, two deliberate holds, both expired cleanly)
Mapped with `scripts/map-dom.ts` (interactive harness; command file protocol,
Book-Time click guard). Confirmed against online-booking.min.js v19.0.13 source.

1. **Teesheet**: date input `#date-field` (MM-DD-YYYY; fill + Enter re-renders),
   players filter chips `a.btn`, tiles `div.time.time-tile` containing
   `.booking-start-time-label` ("6:21pm") and `.js-booking-slot-players` (open
   spots). **Tile click = the hold** (~5 min) AND **auto-sends the code email**
   — no separate confirmation POST needed in the browser flow.
2. **Book Time modal** (BookTimeView): countdown `#booking_countdown`; course/
   date/time/holes as text; players buttons in `.js-booking-field-buttons`.
   ⚠ **CLICK THE "4" BUTTON INSIDE THE MODAL AND VERIFY** — pass 2 had the UI
   highlighting "4" while the model held players="1" (fee window showed $5 not
   $20). Filter-inherited state can lie. Code input
   `#reservation_confirmation_uid`: after fill you MUST fire a jQuery `change`
   (`$(el).trigger("change")`) or the Backbone model never receives it
   (red "Please enter the booking code" validation on book click).
   Resend: `button.js-reservation-confirmation-resend-button`.
   `button.js-book-button` "Book Time": **$0 when booking_fee_required** —
   source path handleBook → server validate → getNextView() →
   PaymentSelectionView.show(); return (no booking call).
3. **Payment Method modal** `#payment_selection`: radio
   `input[name=payment_method][value=course]` ("Pay at Facility") preselected;
   `button.continue` (relabeled "Book Time"). With value=course +
   booking_fee_required → loadPaymentWindow('purchase-fee') — still $0 (renders
   the card window). ⚠ If NO radio were selected, continueReservation falls
   through to payAtCourse() which books immediately — assert the radio first.
4. **Card window**: `#element_iframe` →
   `https://transaction.hostedpayments.com?TransactionSetupID=…` (Element
   Express / Worldpay; provider `credit_card_provider="element"`). Inside the
   frame: `#cardNumber` (type=password), `#ddlExpirationMonth`,
   `#ddlExpirationYear`, `#CVV`, amount `#lblTotalValue`, errors `#divErrors`,
   **`a#submit` "PROCESS TRANSACTION" = THE ONLY CHARGING CLICK**, `a#btnCancel`.
   **NO SAVED-CARD OPTION** — the fee window takes manual card entry only; the
   saved VISA …4071 is never offered here. Playwright can reach the
   cross-origin frame via frameLocator.
5. **Verify hooks before handover**: `App.data.last_reservation` (Backbone
   model: players / time / schedule_id / pending_reservation_id) + iframe
   `#lblTotalValue` must equal $5 × players ($20). Both were read live.
6. **Expiry behavior confirmed**: at 0:00 ForeUp closes the modal, the tile
   reappears, $0 charged.

## STATUS 2026-07-08 evening: rework SHIPPED and $0-verified end-to-end
- `src/turbo.ts` rewritten: API = pure detector (no `hold()`, no
  `triggerEmailCode` — the tile click IS the hold and auto-sends the code);
  ranked candidates clicked in the browser with bounded retry; five money
  gates (modal text → in-modal players click → `App.data.last_reservation`
  model → Pay-at-Facility radio → iframe amount); card pre-filled from
  `FEE_CARD_NUMBER/_EXP_MONTH/_EXP_YEAR/_CVV` (.env placeholders added,
  **values still blank — Isaac must fill them**); `--auto-book` clicks
  `a#submit`. `ui-server.ts` phase map/verdicts updated.
- Full-path live test (07-13 leftovers): detect T+405ms → first tile
  contested, retry worked → HELD → code via IMAP 11s → model verified
  players=4 → fee $20.00 verified → READY — ONE CLICK LEFT at ~T+22s →
  SIGINT, $0. `--no-book` mode also verified (close releases hold instantly).
- NEW GOTCHA (cost a test run): ForeUp's `dateFieldChange` silently DROPS
  date changes while `currentlyRefreshingTeetimes` (e.g. right after the
  players-chip click). `stagePage` therefore fills the date, fires a jQuery
  `change` on `#date-field`, and verifies `App.data.filters` with retries.
  `$('#date-field').trigger('change')` with an UNCHANGED value is the page's
  refresh lever (setDate→refreshTimes runs unconditionally). Enter keypresses
  are eaten by the datepicker popup. `App.data.times.fetch()` (no params)
  WIPES the list — never use.

## Oregon VM (deployed + dry-run-verified 2026-07-08)
- GCP free-tier e2-micro `bethpage-sniper`, zone us-west1-b, project
  `open-487121` (billing already enabled there; no other instances on the
  billing account, so the free-tier slot is ours). 30GB pd-standard, 2GB
  swapfile, TZ set to America/New_York (critical — turbo computes 7pm in
  local time), Node 20, headless Chromium, `HEADLESS=1` appended to .env.
- Latency: VM→foreUP TCP connect ~28ms / TTFB ~0.4s vs Mac ~90-120ms / ~0.6-0.8s.
- Dry run on the VM passed: headless login OK from a datacenter IP, both
  course pages staged, NTP 15ms, IMAP OK.
- `deploy/gcp-setup.sh` is idempotent — re-run it to re-sync code + .env.
- Sunday usage (VM is only useful with auto-book — nobody can click headless):
  `gcloud compute ssh bethpage-sniper --zone=us-west1-b --project=open-487121 -- -t 'cd ~/bethpage-sniper && tmux new -A -s snipe "AUTO_BOOK=1 npx tsx src/turbo.ts --race"'`
  Dashboard from the Mac: add `-- -L 4747:localhost:4747` + `npm run ui` on VM.
- ⚠ ONE MACHINE PER DROP: ForeUp allows one pending reservation per user —
  racing Mac and Oregon simultaneously makes them fight over the hold.

## Dashboard = mission control (2026-07-08 evening)
- `static/turbo-ui.html` + `src/ui-server.ts` now control BOTH machines: a
  "Machine" picker (This Mac / Oregon VM with live status dot), per-target
  mode copy and confirm text, a "Sync code + settings → VM" button (runs the
  idempotent deploy script, streams into the console), card-readiness row
  (boolean only — values never leave the server), and target-aware auto-arm.
- Oregon runs are spawned as `gcloud compute ssh … --command` children and
  stream through the same SSE pipeline; live-on-VM auto-prefixes `AUTO_BOOK=1`
  and is refused while FEE_CARD_* is unfilled. Disarm also pkills the remote
  turbo. Verified live: dry-run armed on the VM from the dashboard →
  SYSTEMS CHECK PASSED. ⚠ The Mac must stay awake during a VM run (the ssh
  stream carries it) — the server's caffeinate already covers this.
- **Proof watcher** (answers "did it actually hit?"): after a run ends in
  BOOKED / ONE CLICK LEFT / FINISH BY HAND, ui-server polls Gmail (IMAP,
  envelope-only) every 15s for up to 12 min for a ForeUp email newer than the
  run start that is NOT a code email → flips the verdict to **BOOKED ✓** with
  the email subject+time as proof (covers the human's PROCESS TRANSACTION
  click, which turbo can't see). Silence for 12 min is reported explicitly.
  UI side: sticky full-height stage (no dead space), idle console shows the
  last run's receipt, verdicts fire tab-title/favicon flips + browser
  notification + WebAudio chime (unlocked on the Arm click).
- **App icon**: `/Applications/Bethpage Sniper.app` — AppleScript applet
  (plain script-executable bundles get LaunchServices error -10669 on this
  macOS even ad-hoc-signed; osacompile + ad-hoc codesign works). It runs
  `deploy/launch-dashboard.sh`: starts the UI server if port 4747 is free,
  then opens http://localhost:4747. Custom ⛳ icon at
  Contents/Resources/applet.icns.

## Race hardening (2026-07-08 final, live-verified at $0)
- Tile click watches ForeUp's pending_reservation REQUEST + RESPONSE:
  no request within 2.5s = "click swallowed" dead tile (real phenomenon —
  07-13 4:42pm reproduces it: API + DOM show the slot, click no-ops, no POST)
  → next candidate in 2.6s (was 12s). Request sent → wait the full response
  window (early bail could strand a pending reservation). Rejected → ~1s.
- Browser pre-fires the sheet refresh every 800ms from T=0 until detection,
  overlapping render with API detect. Measured: dead first tile still HELD
  the next candidate at T+3.3s.
- HEADLESS runs auto-exit 30s after terminal states (VM has no Ctrl+C);
  ui-server treats BOOKED as terminal so the verdict + proof watcher fire
  while the child is still alive. VM re-synced with all of this.

## Phone access + tmux hardening (2026-07-08 last)
- Dashboard-armed Oregon runs live in `tmux` (session `snipe`) on the VM; the
  ssh child replays + follows `logs/live-run.log` and exits when the session
  ends. Survives Mac sleep / wifi drops; **Arm again = reattach** (log replay
  rebuilds the dashboard state). Disarm kills the session. Live-verified.
- The dashboard also runs ON the VM as systemd service `sniper-dashboard`
  (always on, host-aware UI: "This VM (Oregon)", headless, live = auto-book,
  binds 127.0.0.1 only). `deploy/gcp-setup.sh` restarts it after each sync.
- Phone: Tailscale installed on the VM. Finish = (1) approve the login link,
  (2) run `~/finish-phone-setup.sh` on the VM (tailscale serve --bg 4747 +
  prints the private https URL), (3) Tailscale iOS app, same account. The
  dashboard is never on the public internet — tailnet only.

## Remaining before Sunday
1. Isaac fills `FEE_CARD_*` in `.env` (chmod 600 already), then re-runs
   `bash deploy/gcp-setup.sh` so the VM gets them too.
2. Decide the Sunday machine: Oregon (AUTO_BOOK, fastest, zero clicks) or
   Mac (stop-one-click-short, human clicks PROCESS TRANSACTION). Not both.
3. Optional dress rehearsal at a real 7pm drop on a weekday (`--no-book`).
4. Auto-book success detection (iframe detach) is a proxy — unverified until
   a real paid booking happens; default mode does not depend on it.

## 2026-07-12 (post-drop-loss): SYNTHETIC HOLD ARCHITECTURE — see docs/plans/2026-07-12-synthetic-hold-design.md
The 7pm drop was lost (whole Red morning gone <12s; browser render too slow).
Rebuilt the hold path: `holdViaSynth` calls ForeUp's own `TimeView.viewTime()`
via page.evaluate with a model built from the API detection (all classes are
window globals) — first hold attempt T+~0.5s vs T+2.4s. Tile click demoted to
fallback (synth_error only). browserBook split into holdPhase/completeBooking;
courses now race in parallel (one completion ever). Pre-fire refresh REMOVED
(it detached tiles = the "click swallowed" bug). stagePage now stages holes=18
(page default "Both"→holes=all in hold POST = "Invalid request" — old path had
this landmine too). "Invalid request" is ALSO the hold rate-limit message
(~9 attempts/5min trips it — test with --candidates 1, single attempts).
IMAP baseline is set pre-drop + refreshed on closeModal, NOT per-attempt.
PENDING when you read this: one $0 --no-book synth-hold verification (was
rate-limited), then VM re-sync + VM dry-run.

## 2026-07-12 (late): AWS us-west-2 BOX — deployed, verified, dashboard-integrated
ForeUp's origin is AWS us-west-2; this box is on the same datacenter floor.
- `deploy/aws-setup.sh` rewritten to gcp-setup.sh parity + idempotent (finds
  instance by Name tag, restarts if stopped, re-syncs code+.env — same re-run
  gesture as GCP). TZ America/New_York, chrony pinned to Amazon Time Sync
  (169.254.169.123, clock offset ~3ms), 2GB swap, Node 20, sniper-dashboard
  systemd unit (User=ubuntu, 127.0.0.1:4747).
- Instance `<instance-id>` (t3.small, us-west-2a, IAM user sniper-deploy,
  account <aws-account-id>). Key: ~/.ssh/bethpage-sniper-key.pem. IP CHANGES on
  stop/start — resolved live via `aws ec2 describe-instances`. Cost ~$15/mo
  running; stop between drops (`aws ec2 stop-instances --instance-ids …`).
- Measured from the box: TCP connect to ForeUp **1.5–3.8ms** (GCP ~28ms, Mac
  ~70-90ms). Dry run PASSED on the box: WAF login OK from EC2 IP, both courses
  staged players=4 holes=18, NTP 3ms, preflight 16/16 markers, IMAP OK.
- `ui-server.ts` + `turbo-ui.html`: third machine target `aws` — status badge
  (live EC2 state+IP, cached 20s), tmux-hardened ssh runs (same reattach
  semantics as GCP), disarm kills the remote session, "Sync → AWS box" button
  runs deploy/aws-setup.sh (also restarts a stopped instance), live-mode card
  gate applies to ALL remote targets. Course/date/players flow through
  unchanged. Phone → Mac dashboard (tailscale) → AWS box works.
- ⚠ ONE MACHINE PER DROP still: AWS is the fast Sunday machine; don't also arm
  GCP or Mac. ⚠ .env sync pushes Mac's PLAYERS=4 to the box — confirm count
  before a live run.

## 2026-07-13: SYNTH DISABLED (root-caused), tile path default + fixed
- **holdViaSynth was structurally broken, not rate-limited**: it called
  `window.TimeView.viewTime` — ForeUp's LEGACY view. Its createPending POSTs
  only 8 fields → server rejects "Invalid request" (proven by aborting the POST
  offline; same message as the rate limit, different cause). The real Bethpage
  tiles bind to a modern `_AbstractTimeView` subclass (click → `viewTimeRow` →
  16-field createPending → BookingTimeModalView) that is NOT a window global —
  it cannot be reconstructed from the console. Also
  `App.data.course.hasFeature('2024-05-...customer-checkout')` is FALSE for
  Bethpage, so the modal remains the Backbone one the five money gates expect.
  SYNTH is now **opt-in only** (`--synth` / `SYNTH=1`, turbo.ts ~line 134);
  the default hold path is the proven tile click.
- **Tile "click swallowed" root-caused + fixed**: `viewTimeRow` no-ops while
  `App.data.times.isRefreshingTeetimes` is true (mid sheet-refresh) — the click
  looks swallowed but the condition is transient. `holdViaTile` now waits for
  the flag to clear, re-locates the tile, and retries the click up to 4×.
  Verified $0 (07-13): HELD Red 4:24pm at T+2.4s, modal players=1, released $0.
- FLOW_MARKERS extended to 16 (viewTimeRow / createPending / time-tile).
  Typecheck clean, 81/81 tests. One-off diag scripts removed (findings are in
  code comments near the markers/hold path); scripts/map-dom.ts kept.
- Dashboard: AWS us-west-2 box is a first-class machine target alongside Mac
  and GCP (live status badges, tmux-hardened ssh runs, per-target sync
  buttons, day-aware auto-arm today/tomorrow, restyled).
- **Ops gotcha (bit us tonight):** `deploy/aws-setup.sh` / `gcp-setup.sh`
  restart the box's systemd `sniper-dashboard`, which WIPES its in-memory
  schedule — after any sync, re-POST /api/schedule on the box. Also the sync
  pushes the Mac's `.env` (PLAYERS=4) — re-set PLAYERS on the box for
  1-player runs.
- **Live $5 run armed 2026-07-13 18:54 ET** on the AWS box (its own
  dashboard, target "mac" = box-local): live, Red, 1 player, 07-20-2026,
  AUTO_BOOK. Both boxes were re-synced to the fixed build first; Mac + GCP
  verified unarmed (one machine per drop). Outcome: see the run-results
  section below if present, else box logs/live-run.log + race-log.jsonl.

## 2026-07-13 19:00 ET RUN RESULT: BOOKED ✓ — first-ever completed booking
AWS box, live, Red, 1 player, 07-20-2026, AUTO_BOOK. **Red 8:36am booked, $5
charged, fully autonomous** (vulture win on a FALLBACK slot at T+116s).
- Splits (race-log.jsonl): detect 27 times T+507ms (drop poll rtt 371ms vs
  68–96ms baseline) → 6:30am click T+2.67s = swallowed even after the new
  isRefreshingTeetimes retries (tile truly gone server-side, dead at T+5.8s)
  → 6:39/6:48 tile_missing by T+21s (whole 6:30–8:00 window gone <21s) →
  vulture: 7:51am "Time not available" T+24.5s → **8:36am HELD T+97s** →
  modal players=1 verified → IMAP code T+112s → fee $5.00 verified → PROCESS
  TRANSACTION clicked → booked T+116s. All five money gates fired.
- **Confirmation-email subjects now KNOWN** (both no-reply@foreupsoftware.com,
  landed 0.5s post-charge): "Reservation Details" (Congratulations… + TTID)
  and "Reservation Purchase Receipt" (payment receipt). Code email subject:
  "Bethpage State Park: Your Booking Code – Complete Your Reservation".
  Proof watcher flipped BOOKED ✓ off the receipt email as designed.
- Standing conclusion: the browser path cannot win in-window Red at the drop
  (first click T+2.7s is already too late); vulture + fallback is what books.
  If in-window matters more than booking at all, the API-hold→payment bridge
  is still the only path that could compete.
- AWS box left running (always-on dashboard). Stop between drops (~$15/mo):
  `aws ec2 stop-instances --region us-west-2 --instance-ids <instance-id>`

## 2026-07-13 (late): BRIDGE HOLD — API-speed holds through ForeUp's modern view
Goal (Isaac): beat the co-located bots to IN-WINDOW slots. The tile path's
~2.2s render wait is the whole gap; the payment path is fine (it runs after
the hold locks the slot).
- `holdViaBridge` (new PRIMARY): the modern tile view class is not a window
  global, but it IS reachable from ForeUp's live Marionette tree:
  `App.page.currentView.content.currentView` (TimeTilesView — exists at stage
  time, before any tile renders) → `.itemView` = TimeTileView →
  `Object.create(TimeTileView.prototype)` with fake `$el = $()` →
  `fake.viewTime(new App.data.times.model(apiAttrs), false)`. That runs
  viewTimeDeprecated (Bethpage lacks '2024-05…customer-checkout') → the same
  16-field createPending POST as a human click → BookingTimeModalView.show()
  → the modal itself sends the code email (_sendConfirmationCode). Money
  gates and completeBooking are untouched.
- **$0-verified live (Green leftovers): detect T+370ms → bridge hold fired
  T+371ms (1ms later; tile path needed ~2.2s) → HELD T+1.0s → modal
  verified → released $0.** Tile click remains the fallback on bridge_error.
  `--no-bridge` / `BRIDGE=0` disables; the old `--synth`/`SYNTH` flag is gone.
- `bridgePreflight` runs at every stagePage (dry runs included): tile-view
  class reachable; customer-checkout feature still OFF (ON = Vue checkout,
  modal gates break); force-recaptcha-on-tile-click still OFF (the bridge
  skips viewTimeRow's captcha check — if ForeUp activates it, review both
  paths); bag empty. FLOW_MARKERS now 18 (+viewTimeDeprecated,
  +BookingTimeModalView). Typecheck + 81/81 tests green.
- Playwright gotcha (cost one dry run): `page.evaluate(string)` evaluates the
  string as an EXPRESSION — a stringified arrow fn returns the function
  object (serializes to undefined) and args are ignored. Use flat arrow
  functions (no nested fns — the tsx/esbuild __name issue only bites nested
  functions), or IIFE strings.
- Deployed to AWS box + GCP VM; AWS dry run green (bridge ready, 18/18).
- **$0 DRESS REHEARSAL ARMED (AWS box dashboard): 2026-07-14 18:54 ET, test
  mode (--no-book), red+green, players=1, date 07-21-2026.** It answers:
  (1) bridge speed under real drop contention — compare race-log bridge_hold
  tPlusMs vs tonight's 2.7s first tile click; (2) whether the existing 07-20
  Red booking makes ForeUp REJECT new Red holds (14-day-restriction semantics
  at the hold level are unknown — decides whether next Sunday can even target
  Red). Check box logs/race-log.jsonl after ~7:02pm.

## 2026-07-13 (late night): SPEC — speculative pre-aimed hold (remove detection latency)
Goal (Isaac): "make it faster, we must beat the bots." The bridge already
fires the hold 1ms after detection, so DETECTION (~370-450ms poll RTT under
drop load + one round-trip) is the entire remaining floor — and a co-located
bot that blind-fires createPending without polling beats any detect-first
design by exactly that gap. SPEC removes the detection wait.
- **Protocol fact that makes it possible** (online-booking.min.js v19.0.13
  source + live POST capture): createPending `_.pick`s exactly 16 fields —
  time, holes, players, carts, schedule_id, teesheet_side_id, course_id,
  booking_class_id, duration, foreup_discount, foreup_trade_discount_rate,
  trade_min_players, cart_fee, cart_fee_tax, green_fee, green_fee_tax. ALL are
  predictable pre-drop; NOTHING in the hold POST comes from the times response
  (no per-slot token/nonce). The times endpoint is a pure detector, not a
  source of a required credential.
- `--spec` / `SPEC=1` (requires --bridge default + --race). Pre-drop,
  `buildSpecCandidates` scouts every OTHER published date (today..today+7 —
  dates <7 days out are always live) + saved drop snapshots, merges to one
  time-of-day TEMPLATE (`mergeSpecTemplate`, same-day-type sheets preferred:
  weekend vs weekday fee columns differ), swaps in the target date
  (`specPredictTimes`), ranks with the SAME rankCandidates, arms the top
  in-window slot. At T=0 `specStrike` BLIND-FIRES holdViaBridge at that slot
  at offsets T+150/450ms (`--spec-fire`/SPEC_FIRE_MS, ≤3 shots/course for
  rate-limit hygiene), NO poll wait, bridgeOnly=true (no tile fallback pre-
  flip). The normal detect→bridge walk runs underneath; a landed spec hold is
  settled first so two holds never race one page.
- **LANDMINE (found+fixed at $0):** viewTime copies `available_spots` into the
  POST's `players`; server rejects players>actual_spots ("Time not
  available"). specPredictTimes pins available_spots to the requested player
  count — correct on any slot with room, harmlessly rejected otherwise. (Do
  NOT fake a full-4 sheet.)
- **$0-VERIFIED (Green live sheet, 07-14 2:45pm, players=1):** scout built a
  16-slot template from 6 sheets → blind bridge POST fired **T+1ms (zero
  poll)** → HELD **T+701ms** → modal verified → released $0. vs bridge-with-
  detection ~T+1.0-1.2s. The ~400-450ms detection term is gone.
- Every detection now also snapshots the full times payload to
  logs/sheets/<course>-<date>.json (off hot path, setImmediate) — a captured
  DROP sheet is the only template source that has the sold-out MORNING grid
  (published dates have those slots booked). Library grows each run.
- tsc clean, 97/97 tests (+16 SPEC prediction tests, pure fns mirrored in
  tests.ts). Telemetry: spec_scout, spec_shot. NOT yet deployed to AWS/GCP
  boxes, NOT yet run at a real contested drop. Next: sync boxes, then the
  07-14 dress rehearsal (or a Sunday) can add `--spec` to measure blind-fire
  HELD time under real contention vs detect-first bots.
- ⚠ RATE LIMIT: a spec MISS is still a real hold attempt. Default 2 shots ×
  courses = up to 4 holds/drop; keep ≤3/course and never loop. "Invalid
  request" (distinct from "Time not available") = soft rate limit tripped.

## 2026-07-13 (late night): SERVER-CLOCK SYNC + bot-landscape research
Research on the fastest public ForeUp/Bethpage bots (peterjmoffatt-wq/
tee-time-watcher, jardysuntan/bethpage-tee-time-sniper) confirmed the SPEC
premise (hold POST needs no per-slot token — only predictable fields + a
pre-drop JWT) and surfaced the ONE timing tactic we lacked: sync to ForeUp's
OWN server clock, not NTP. The drop fires on the server's clock; NTP only
helps if their servers are perfectly disciplined.
- `foreupServerOffset()`: samples ForeUp's times endpoint every 15ms until the
  HTTP `Date` header's second value increments (tick-boundary detection),
  pins the server-second boundary to ~±60ms, returns the offset.
  `serverOffsetFromFlip()` is the pure, unit-tested math.
- Wired in: at startup, server-clock offset is PRIMARY (NTP runs in parallel
  as a cross-check + fallback if the Date probe fails); logged as
  "Clock offset: Xms (ForeUp server clock; NTP says Yms, ΔZms)". A T-30s
  re-sync in the pre-drop wait corrects drift measured minutes earlier at arm
  time. Telemetry: clock_sync, clock_resync.
- Live-verified (dry run): ForeUp 36ms vs NTP 27ms (Δ9ms — disciplined now,
  but drift is now caught and NTP-invisible drift can't silently miss the drop).
- Research also established: nobody pure-blind-fires (pre-release the times
  endpoint returns [], so early holds just error + burn WAF budget) — so SPEC's
  shots must land AFTER server release, and the detect→bridge walk underneath
  is the safety net. WAF = transient 403/429/5xx under burst (the "Invalid
  request" soft-limit), retryable with backoff. Confirm step is email-2FA +
  reCAPTCHA since Oct-2025 (downstream of the hold; doesn't affect the speed
  race). jardysuntan keeps its hold on the UI path to dodge bot-detection —
  our bridge already routes through viewTime (ForeUp's own UI handler), so
  we're on that safer path, not raw-API.
- tsc clean, 101/101 tests (+4 clock-sync). NOT yet deployed to boxes.

## 2026-07-14 (late): DROP REHEARSAL RESULT + RED-FIRST HARDENING (LOCAL ONLY)

The AWS `$0` rehearsal that had been armed for 18:54 ET completed safely:
Green 6:39am held and was released, no charge. SPEC did not shoot because the
old box build found no usable prediction template; Red exposed only late slots.
The useful timing result was first-sheet detection around T+272/T+291ms. It
also exposed that the then-current telemetry epoch was poll-relative rather
than release-relative. The dashboard backend SPEC passthrough and the visible,
checked SPEC toggle are now both implemented; `/api/arm` and `/api/schedule`
send `spec:true`, and `/api/state` exposes it.

Isaac's clarified policy is now encoded locally: **any Red before 8:30am is
preferred over Green; latest acceptable first** (`COURSE=red,green`,
`WINDOW_END=FALLBACK_UNTIL=8:30`, `SLOT_ORDER=latest`). The read-only SPEC
scout currently predicts Red **8:27am at T+150ms**, then **8:18am at T+450ms**.
Only the first configured course blind-fires; Green runs as the streaming
detect-first fallback. Detection starts for every course at T-200, Green may
hold while Red is still resolving, and a later valid Red displaces Green only
after exact course/date/time identity is checked. Every loser reservation ID
must receive a verified DELETE before checkout. Sent/no-response is terminal,
not retryable. Already-attempted slots are not retried.

Other local hardening in this pass:

- Scheduled telemetry is anchored to the fixed 7pm server-release epoch.
- Clock sync uses DNS-corrected 3-sample NTP plus bounded ForeUp Date-transition
  sampling, with ForeUp primary only when within 125ms of NTP. Every fetch has
  a header+body timeout and T-30 sync cannot begin close enough to straddle T=0.
- One authenticated BrowserContext per course isolates ForeUp's single
  `localStorage.pending_reservation`; successful reservation IDs are ledgered
  and exact native deletion is the fallback cleanup path; that fallback is
  also bounded so a stalled DELETE blocks checkout instead of hanging forever.
- SPEC snapshots are immutable/atomic, same weekday class is preferred, target
  snapshots are excluded, partial sheets can fill the 9-minute lattice, and
  incomplete 16-field prediction templates are excluded before blind fire.
- Duplicate course keys are deduplicated. A lower-priority Green response gets
  a full second for preferred Red before poll shutdown.

**Validation (local, read-only, 2026-07-14 ~22:08 ET):** `npm test` 189/189;
`npm run typecheck` clean; dashboard inline JavaScript parses; `--dry-run
--spec --no-book --course red,green --players 1 --date 07-21-2026` staged both
isolated contexts, found the exact release helper, matched all 18/18 ForeUp
markers, measured ForeUp +75ms vs NTP +45ms, and printed only the two Red shots
above. No hold endpoint was invoked.

**DEPLOYMENT STATE / REQUIRED NEXT STEP:** these race changes are **LOCAL ONLY**.
AWS and GCP still have older code. Mac, AWS, and GCP dashboards all reported
`running:false`, `schedule:null`; nothing is armed. Although an older run proved
ForeUp can return HTTP 200 for Red and Green holds, the new two-context
coexistence + exact-release path has not been deliberately live-validated.
Before any real deployment, run one bounded `--no-book` `$0` two-context
coexistence/release rehearsal, then sync and arm exactly one AWS machine. Never
arm Mac/GCP for the same drop and never add AUTO_BOOK without Isaac's explicit
approval.

Start by reading memory + turbo.ts, confirm the current state back to me, then
give me a short plan before changing code.
