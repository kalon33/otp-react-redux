# CLAUDE.md — otp-react-redux (TransitNav frontend)

The rider-facing app: trip planning UI, Go Mode live navigation, and the OTP2 query
layer. Ships to the phone as an OTA web bundle; **"the app" always means the native
iOS/Android app, never the dev server or a browser tab.**

## The backlog protocol — read this before planning anything

**There is exactly one backlog for TransitNav:**
`~/.claude/plans/please-make-a-centralized-sharded-petal.md` — numbered tiers spanning
all four repos (`transitnav`, `otprr/otp-react-redux`, `transitnav-ios`,
`otp-minneapolis`) and the Obsidian vault. Read it before you plan or start anything,
and **verify the item against current source** — not against the note and not against
the commit message. In nine of the last ten sessions the plan or a ride note was wrong
about the *mechanism*.

**Anything you find that should be fixed later goes in that file and nowhere else.**
Dedupe against the existing tiers first (a recurrence is an observation added to the
existing row, never a new row). Then: a numbered row with a bolded one-line finding and
a Note carrying real evidence — `file:line`, actual numbers, timestamps, the measurement
you ran; a Session index row naming the repo; a Sequencing constraint if order matters;
and what you **ruled out**. Never delete a row — mark it `**DONE** <sha>` or move it to
"Closed — do not re-plan".

**Nothing floats anywhere else.** No `## Fix backlog` in a ride report, no new plan file
of open items, no `TODO(later)` in source, no scratch Markdown of things to fix.
Evidence documents stay put — ride reports in `~/obsidian-vault/Claude/ride-watch/` are
daemon-owned, and the rider's vault notes are the rider's — read them, cite them, link
them, but promote the actionable item into the plan. Notes are evidence; the plan is the
index. If you find something floating, promote it and say so.

The full protocol is in `~/.claude/CLAUDE.md`.

## Git

Ask before committing: show the proposed message and the file list, and wait for
explicit approval.

## Traps specific to this repo

- **Shared worktree.** Other agents work in this same checkout. Never `git stash`,
  commit only your own paths, and leave pre-staged work alone.
- **`yarn unit` clobbers the dev config — and `port-config.yml` in THIS repo is not
  the way back.** The a11y suite overwrites `tmp/config.yml` and silently breaks the
  live :9967 dev server. `tmp/config.yml` is a *copy*: vite writes it from
  `$YAML_CONFIG` on startup (`vite.config.js:43`), and the `otp-frontend-dev` container
  sets `YAML_CONFIG=/app/port-config.yml` from a read-only bind mount of
  **`otp-minneapolis/frontend/port-config.yml`** — that file is the source of truth
  (`host: https://api.transit-nav.com`). Restore from it, or just
  `docker restart otp-frontend-dev`. The `port-config.yml` sitting in this repo is an
  untracked local copy (`.gitignore` has `*config.yml`) that nothing reads; it still
  said `host: https://tre.hopto.org` on 2026-09-02, whose cert expired 2026-08-09, so
  restoring from it is how you break :9967 rather than how you fix it.
- **The nightly verify run is not in this repo.** It is
  `otp-minneapolis/scripts/nightly-verify.sh` (crontab `0 5 * * *`, log
  `/tmp/otp-nightly-verify.log`, report into the vault); `scripts/verify-*.js` here are
  what it drives.
- **`scripts/verify-*.js` hang against current Chrome.** Repo puppeteer 10 vs an
  auto-updated Chrome. Use a scratchpad `puppeteer-core` with
  `--disable-dev-shm-usage`, an iPhone UA, and `/#/hash` routes.
- **The config here is not the one that ships.** The phone builds from
  `transitnav-ios/web-config/app-config.yml`; configs in this repo are gitignored and
  get overwritten by the build.
- **Pushing is not shipping.** After a Go Mode push, dispatch **both**
  `testflight.yml` and `play-internal.yml`, and report the build numbers.
