# Build Doc: claudetfawa — temporary self-hosted Claude Code re-auth portal

## Objective

A small, **temporary**, self-hostable web utility for Claude Code users on subscription plans (Pro, Max, etc.) whose Claude Code instance runs on a headless, web-connected Linux machine (VPS, VM, home server). It solves the headless re-auth problem: `claude /login` opens an OAuth URL and expects a code pasted back into an interactive TUI, which is painful or impossible over mobile SSH clients, web terminals with broken clipboards, or automation contexts.

The flow:

1. You start the portal over SSH; it prompts you for a **one-time password for this run** and prints the URL to open.
2. From your phone/desktop browser, you enter that password — the password form is the only thing the site exposes.
3. You hit "Start Claude Login"; the portal runs `claude /login` and shows the OAuth URL as a clean, tappable link.
4. You complete the Claude login in your browser and paste the returned code into the portal.
5. The portal feeds the code back into the CLI, confirms real credentials landed, and you shut it down.

**This is not an always-on service.** You bring it up when you need to (re-)authenticate, and take it down when the token is minted. If you forget, it shuts itself down after 30 minutes of inactivity.

**Design goals:**

- **Works on a freshly spun-up, clean Linux server.** No pre-installed Node, no reverse proxy, no domain, no DNS. One bootstrap command installs everything it needs; the app terminates its own TLS.
- **Zero setup ceremony.** No stored credentials, no enrollment step, no config files required. The password is chosen at launch, lives only in process memory for that run, and dies with the process.
- **Ephemeral by design**: explicit "Shut down" button on the dashboard, automatic exit after 30 minutes of inactivity, fail-closed shutdown under brute-force attempts, pty and listeners cleaned up on every exit path.
- **Single-purpose and small**: no accounts system, no database. One Linux user, one Claude Code install, one short-lived portal.

## Feasibility: verified

The critical mechanism — driving Claude Code's Ink/raw-mode TUI through a pseudo-terminal — was **tested end-to-end on a real VPS on 2026-07-03 against Claude Code 2.1.200**:

- `node-pty` compiles and runs cleanly on Node 20.
- `claude /login` spawned in a pty renders the TUI, and keystrokes/text written to the pty are delivered correctly (verified by stepping through the interactive prompts and submitting a code that the CLI validated and rejected with "OAuth error: Invalid code").
- All three install states reach the OAuth URL by answering each prompt with a single Enter: **never-run** (theme picker → method selector → URL), **run-but-never-authenticated** (identical — onboarding repeats until a login succeeds), and **previously-authenticated re-auth** (trust prompt → method selector → URL). Never-run and run-but-unauthenticated were simulated with a scratch `CLAUDE_CONFIG_DIR`.
- The OAuth URL (~450 chars) is extractable from ANSI-stripped output.
- A wrong code is recoverable: the TUI offers "Press Enter to retry" and issues a fresh URL, so retry works without respawning the process.

The empirical findings below are **requirements** for the pty driver, not suggestions.

## Architecture

```
Browser (phone/desktop) → https://<server-ip>:61897 (built-in TLS, self-signed cert)
  → Node/Express app → node-pty → `claude /login` (as the same Linux user)
```

- **Default port: `61897`.** Chosen to be collision-proof: above the Linux default ephemeral range (32768–60999), so the kernel never hands it to an outgoing connection, and unregistered with IANA, so no daemon claims it. Overridable via `PORT` env var or `--port` flag.
- **The app terminates TLS itself.** On start it generates a self-signed cert (`selfsigned` package) and prints the **certificate's SHA-256 fingerprint** in the terminal. The browser will warn about the self-signed cert; the user verifies the fingerprint shown in the warning against the one in their SSH terminal, then proceeds. For a portal that lives for minutes, this beats requiring a domain + reverse proxy + ACME on a fresh box.
- **Binds `0.0.0.0:61897`** while running — there is no reverse proxy to hide behind, and the utility is only up for the duration of the auth. Startup prints the exact URL to open (`https://<detected-public-ip>:61897`).
- Runs as the **same Linux user** that owns the Claude Code install, since `claude /login` writes to that user's `~/.claude/.credentials.json`.
- **No process supervisor.** Run it in the foreground of your SSH session (or inside `tmux` if your connection is flaky). A supervisor that restarts it would fight the self-shutdown behavior.

## Requirements

- Linux server (x86_64 or arm64), fresh is fine.
- Claude Code installed and on `PATH` for the user, with a subscription (Pro/Max) account. (If the box is so fresh it lacks Claude Code, install that first — this tool authenticates an existing install.)
- `sudo`/root available **once**, for the bootstrap installer to add Node.js and build tools if missing. The app itself runs unprivileged.
- Inbound TCP on the chosen port (default 61897) reachable from your phone/browser. On cloud VPSes, this may mean temporarily allowing the port in the provider's security group / firewall — the README must call this out, and remind the user to close it again after teardown.

## Bootstrap installer (`install.sh`)

One command on a clean server:

```bash
curl -fsSL https://raw.githubusercontent.com/spfrood/claudetfawa/main/install.sh | bash
```

The script (idempotent, safe to re-run):

1. Detects the distro and installs prerequisites if missing: Node.js ≥ 20 (via NodeSource or distro package) and `node-pty`'s build toolchain (`python3`, `make`, `g++` / `build-essential`). This is the only step that needs sudo; everything else runs as the invoking user.
2. Clones (or updates) the repo to `~/claudetfawa` and runs `npm install`.
3. Prints the run command (`node ~/claudetfawa/server.js`) and a short "open your firewall for port X / close it when done" reminder.

There is **no setup step** — no secrets are provisioned or stored. For users who distrust `curl | bash`, the README documents the equivalent manual steps (clone, `npm install`).

## Launch-time password (replaces stored credentials)

- On start, `server.js` prompts for a password on the terminal (masked input via readline raw mode — no extra dependency). **Minimum 12 characters, enforced.** Interactive prompt only — no `--password` flag and no env-var fallback, so the password can't leak into shell history or `/proc/<pid>/environ`.
- The plaintext is immediately bcrypt-hashed in memory and discarded; login attempts verify against the in-memory hash. Nothing is ever written to disk.
- The session secret is generated randomly per run (32+ bytes) — sessions don't need to survive a restart, because nothing does.
- Each run is a fresh password. There is nothing to rotate, leak from a dotfile, or forget.

## Lifecycle (ephemeral by design)

- **Start**: `node server.js` → password prompt → prints the URL, the cert fingerprint, and "portal will exit after 30 minutes of inactivity."
- **Inactivity self-shutdown**: the process exits after **30 minutes with no *authenticated* HTTP request**. Unauthenticated requests (scanners probing the port, failed logins) must **not** reset the timer — otherwise background internet noise keeps the portal alive indefinitely. Before the session is first established, the 30 minutes counts from process start.
- **Fail-closed under attack**: after **20 total failed password attempts** (across all IPs, cumulative for the run), the portal prints a warning to the terminal and exits. With single-factor auth on a public port, the correct response to a determined guesser is to stop existing — the user can relaunch with a new password in seconds.
- **Manual teardown**: the dashboard shows a **"Shut down portal"** button at all times, and prominently on the success screen. It ends the process cleanly. Ctrl-C in the SSH session does the same.
- **On every exit path** (button, inactivity, fail-closed, SIGINT/SIGTERM, crash handler): kill any live pty, close the HTTPS listener, then exit. `pgrep -f "claude /login"` must find nothing afterward.
- **After success**: the success screen confirms credentials landed, reminds the user that already-running Claude Code processes (e.g. in tmux) need restarting to pick up the new token, reminds them to re-close the firewall port if they opened it, and offers the shutdown button. The inactivity timer remains the failsafe if they just close the tab.
- **Test-mode overrides**: the three durations (30-min inactivity shutdown, 15-min session expiry, 5-min pty timeout) are readable from env vars (`IDLE_SHUTDOWN_SECS`, `SESSION_TTL_SECS`, `PTY_TIMEOUT_SECS`) so the test suite can exercise them in seconds instead of wall-clock waits. Defaults are the documented values; the UI is a non-goal for these — they exist for testing, not configuration.

## Auth flow

1. `GET /` — the password form. This is the **only** unauthenticated surface; every other route redirects here. No branding beyond a minimal page — nothing that advertises what the portal does to a scanner.
2. `POST /login` — rate-limited (`express-rate-limit`, 5 attempts / 10 min per IP) and counted against the global 20-failure shutdown cap. Verify against the in-memory bcrypt hash. On success: session (`express-session`; `httpOnly`, `secure`, `sameSite: 'strict'`, `maxAge` 15 min **fixed** — do not extend on activity). On failure: a generic error.
3. All further routes require `req.session.authenticated === true` via middleware.
4. `GET /dashboard` — "Start Claude Login" button, "Shut down portal" button.
5. `POST /start-login` — spawn the pty driver (below). Stream status + the extracted OAuth URL to the page via SSE.
6. `POST /submit-code` — write the pasted code to the pty (`pty.write(code.trim() + '\r')`), relay the outcome.
7. On reported success, **verify server-side** that `~/.claude/.credentials.json` changed and contains a non-empty `accessToken` before telling the UI it worked — never trust the process exit code alone.
8. Kill the pty on completion, on error, or after a 5-minute pty-level inactivity timeout. Only one pty session at a time; a second `/start-login` kills and replaces the first.

## Dependencies

```
npm install express express-session bcrypt express-rate-limit node-pty selfsigned
```

(No `otplib`, `qrcode-terminal`, or `dotenv` — there are no stored secrets and no config file. No `strip-ansi` either: v7+ is ESM-only, which breaks `require()` on older Node 20 patch releases, so its regex is inlined in the pty driver.)

**Implementation gotcha, verified by test**: even with `rolling: false`, express-session calls `store.touch()` on every request, silently extending the server-side expiry — the fixed 15-minute session must be enforced with an explicit `createdAt` timestamp check, not by cookie/store expiry.

## PTY driver — verified behavior (Claude Code 2.1.200, 2026-07-03)

This is the core of the app and the part most exposed to Claude Code version drift. All of the following was observed on a real re-auth attempt:

1. **Spawn wide.** Use `pty.spawn('claude', ['/login'], { name: 'xterm-256color', cols: 500, rows: 50, ... })`. At default widths Ink wraps the ~400-char OAuth URL across lines, breaking extraction. At 500 cols it arrives contiguous.
2. **Sanitize the child environment.** Delete `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, and `CLAUDE_CODE_SSE_PORT` from the spawned env so the CLI behaves like a fresh terminal rather than a nested session.
3. **Up to three interactive prompts precede the URL, varying with the install's state.** All three CLI states were tested (2026-07-03, v2.1.200): never-run, run-but-never-authenticated (simulated via a scratch `CLAUDE_CONFIG_DIR`), and previously-authenticated re-auth. Every prompt is answerable with a single `\r` (the default choice is always the right one), but **which prompts appear depends on state**, so the driver must treat each as optional and detect screens by content, not by position in a fixed sequence:
   - A **theme picker** (first-run onboarding; shows a syntax-highlighting preview, "Syntax theme: …"). Appears on never-run *and* run-but-unauthenticated installs — onboarding isn't marked complete until a login finishes, so it reappears on every attempt until auth succeeds.
   - A **workspace-trust prompt** ("Is this a project you created or one you trust?"). Appeared on the previously-authenticated install; did *not* appear during first-run onboarding.
   - A **login-method selector** ("Select login method:", 3 options — subscription / Console / third-party platform). Appears in **all** states; the subscription account is the default selection.
4. **Prompt detection must tolerate collapsed whitespace.** Ink positions text with cursor movements, so ANSI-stripped output often loses spaces ("trustthisfolder", "Pastecodehereifprompted"). Match prompts with whitespace-optional regexes (e.g. `/trust\s*this\s*folder/i` applied to output with spaces stripped, or normalize by removing all whitespace before matching).
5. **URL extraction**: strip ANSI (`strip-ansi`), then match `https:\/\/claude\.(?:com|ai)\/\S*oauth\S+`. Do **not** use a bare `https://\S+` — the TUI banner contains other links (promos, "Security guide"). As of 2.1.200 the URL is `https://claude.com/cai/oauth/authorize?...`; keep the `.ai` alternative for older/newer versions.
6. **Code entry**: after the URL, the TUI shows a "Paste code here if prompted >" field. `pty.write(code + '\r')` is delivered correctly.
7. **Failure is recoverable**: an invalid code yields "OAuth error: Invalid code. Please make sure the full code was copied" and "Press Enter to retry"; retrying re-issues a fresh URL in the same process. The driver should surface the error and support retry without respawning.
8. **Success detection**: watch for the TUI's success state, then confirm against `~/.claude/.credentials.json` (content changed + non-empty `accessToken`).
9. **Credentials landing is not the end — onboarding must complete.** Killing the pty the moment credentials appear leaves first-run onboarding unfinished, and the CLI then re-runs onboarding *including a fresh OAuth login* on the next start, ignoring the valid credentials on disk (verified against 2.1.200 on a real fresh-VPS run). After verifying credentials, keep pressing Enter through the remaining screens until the REPL marker (`? for shortcuts`) appears, then kill.
10. **Send Enter separately from the pasted code.** Real codes (~130 chars) trip the TUI's paste-burst handling; a `\r` glued to the paste is swallowed as paste content and the field never submits (short test codes stay under the threshold and hide this). Write the code, wait ~500ms, then write `\r` as its own keystroke.

**Version-drift guard**: prompts and URLs will change across Claude Code releases. The driver should be a small state machine with a hard overall timeout, and when it can't recognize the current state it must fail *visibly* — show the last ~30 lines of ANSI-stripped output in the dashboard as a debugging/manual fallback — rather than hang silently. Record the tested Claude Code version in the README and re-verify after major CLI updates.

## Security checklist

- Password chosen fresh at every launch, ≥12 chars enforced, held only as an in-memory bcrypt hash, never written to disk, never accepted via flag or env var.
- The unauthenticated surface is exactly one minimal password form; everything else requires a session.
- Rate limiting per IP on `POST /login`, plus the global 20-failure fail-closed shutdown.
- Generic error on failed login.
- Session cookie: `httpOnly`, `secure`, `sameSite: 'strict'`, 15-minute fixed expiry; session secret regenerated every run.
- Self-signed TLS with the cert fingerprint printed at startup for out-of-band verification over SSH — all credentials transit encrypted, and the user can detect a MITM on first connect.
- Unauthenticated requests never reset the inactivity timer; internet background noise cannot keep the portal alive.
- pty processes are killed on every exit path; one active session max.
- Exposure window is minutes, not months: the portal is up only while the user is actively authenticating, kills itself after 30 idle minutes, and kills itself under brute-force pressure.
- **Threat framing for the README**: whoever passes the password form can mint Claude credentials on your server. Single factor, so the password *is* the perimeter for the minutes the portal is up — pick a strong throwaway (a passphrase you'll never reuse), and take the portal (and any firewall rule you opened for it) down when you're done.

## Testing checklist (before calling this done)

1. Full happy path against a real re-auth: launch with password → browser login → spawn → prompts auto-answered → URL displayed as link → code pasted via the form → `~/.claude/.credentials.json` shows a new non-empty `accessToken`.
2. All three CLI states reach the URL: never-run (`CLAUDE_CONFIG_DIR` pointed at an empty dir), run-but-never-authenticated (same dir, second attempt), and previously-authenticated re-auth.
3. Invalid-code path: error surfaced in the UI, retry works in the same session.
4. Password under 12 chars is rejected at the launch prompt.
5. Session expires at exactly 15 minutes and redirects to the password form; activity does not extend it.
6. Rate limit locks out an IP after 5 attempts; 20 cumulative failures shut the whole portal down.
7. Inactivity shutdown: with no authenticated requests, the process exits at 30 minutes; unauthenticated probes (curl the password form repeatedly) do **not** extend it.
8. "Shut down portal" button and Ctrl-C both exit cleanly: HTTPS listener closed, and `pgrep -f "claude /login"` finds nothing.
9. Cert fingerprint printed at startup matches what the browser shows in the certificate details.
10. **Fresh-server test (the headline claim)**: brand-new clean VPS with Claude Code installed but **never run** → one-line `install.sh` → `node server.js` → complete a real auth from a phone browser → shut down. No undocumented steps allowed.

## Non-goals

- Always-on operation, process supervisors, uptime monitoring — this is a run-then-kill utility.
- Stored credentials, TOTP/2FA enrollment, config files — the launch-time password model replaces all of it.
- Domains, DNS, Let's Encrypt/ACME, reverse proxies — built-in self-signed TLS is the model. (Users who already have a proxy can of course put it behind one and bind localhost via `PORT`/`--bind`.)
- Multi-user / multi-account support — one portal per Linux user.
- Windows/macOS hosts.
- Managing API-key (non-subscription) auth — `ANTHROPIC_API_KEY` users don't need this tool.
