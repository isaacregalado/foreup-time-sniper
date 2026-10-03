# Verify prompt — Bethpage sniper "bridge hold"

Paste everything below into a fresh session at `~/bethpage-sniper`.

---

I'm continuing my Bethpage tee-time sniper at `~/bethpage-sniper` (TypeScript;
`src/turbo.ts` is the flagship, `src/ui-server.ts` the dashboard). **Read the
project memory `project_bethpage_sniper.md` and `HANDOFF.md` first, then confirm
state back to me before running anything.**

## Context — what you're verifying
On 2026-07-13 I shipped a new PRIMARY hold path called the **bridge hold**
(`holdViaBridge` in `src/turbo.ts`). Its whole purpose is to beat co-located
bots to an in-window slot by holding at API speed instead of waiting ~2.2s for
tiles to render. It works by borrowing ForeUp's own live tile-view instance —
`App.page.currentView.content.currentView.itemView` (TimeTileView) — and calling
its `viewTime()` on a model built from the API detection, which fires the exact
same 16-field `createPending` hold POST as a human tile click. Tile click is the
fallback (`--no-bridge` disables the bridge). It was $0-verified once on Green
leftovers (detect T+370ms → hold fired T+371ms → HELD T+1.0s → released $0). It
has NOT yet completed a *paid* booking — tonight's real booking used the tile
path.

## Your task: prove the bridge still works, end-to-end, at $0
Do these in order and report findings after each. **Do not change code unless a
step fails** — this is a verification pass, not a rebuild.

1. **Static checks.** `npx tsc --noEmit` and `npm test` (expect 81/81). Confirm
   `holdViaBridge` is the primary path in `holdPhase` and the old `synth`
   naming is gone.

2. **Dry run (no hold, $0).** `HEADLESS=1 npx tsx src/turbo.ts --dry-run --course green`.
   Confirm the log line `Bridge ready on Bethpage Green Course: modern tile view
   reachable, Backbone modal flow confirmed` and `ForeUp preflight: v… all 18
   flow markers present`. If the bridge preflight warns (class unreachable /
   customer-checkout ON / captcha ON), STOP and tell me — ForeUp changed
   something.

3. **One $0 bridge hold on GREEN leftovers.** Green only, never Red (I have a
   real Red booking on 07-20 and don't want to touch its restrictions). Use a
   near date with leftover afternoon times and a wide window so a hold is
   available, e.g.:
   `HEADLESS=1 npx tsx src/turbo.ts --no-book --course green --date <MM-DD-YYYY> --from 12:00 --to 19:00 --players 1`
   Success = `bridge hold … ForeUp viewTime() direct` → `HELD …` →
   `Verified: modal shows …` → `NO-BOOK MODE … Closing modal — hold released,
   $0 charged.` Then read the last line of `logs/race-log.jsonl` and report the
   `bridge_hold` result + `tPlusMs` and the `no_book_abort` outcome.

4. **Report** the detect→hold timing and whether the bridge fired (vs falling
   back to the tile click). If it fell back, dig into why (the `bridge_error`
   telemetry + the `bridge_preflight` event have the reason).

### Money-safety — hard rules (unchanged, do not violate)
- My single account only. No proxies, no multi-account, no evasion.
- The ONLY thing that charges is the final PROCESS TRANSACTION click ($5/player).
  `--no-book` and `--dry-run` are $0. Do NOT pass `--auto-book`/`AUTO_BOOK=1`.
- Holds are soft-rate-limited ("Invalid request" after ~9 in 5 min). Make **one
  deliberate hold per test, never in a loop.** If a hold is rejected, do not
  immediately retry the same slot.
- GREEN only for tests. Do not hold Red — protect the 07-20 booking.
- If anything about modal state (course/date/time/players) looks wrong, the code
  already aborts before the pay step; if you're unsure, close the modal and stop.

## Also live right now (don't disturb unless asked)
- A **$0 dress rehearsal** is armed on the AWS box (`<vm-public-ip>`, key
  `~/.ssh/bethpage-sniper-key.pem`) for **2026-07-14 18:54 ET**: test mode
  (`--no-book`), red+green, players=1, date 07-21-2026. It measures bridge
  speed under real drop load and whether the 07-20 Red booking blocks new Red
  holds. Leave its schedule alone. After ~7:02pm 07-14, its
  `logs/race-log.jsonl` has the answer.
- ONE MACHINE PER DROP (ForeUp allows one pending reservation per account) — if
  you run a local test, make sure no box is armed for the same moment.

Confirm state, run the checks, and tell me: **does the bridge hold still fire and
hold at $0, and how fast?**
