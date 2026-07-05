# claudetfawa

A small, **temporary** self-hosted web portal for completing [Claude Code](https://claude.com/claude-code)'s CLI `/login` OAuth flow from a phone or desktop browser — for Claude Code users on subscription plans (Pro, Max, etc.) whose instance runs on a headless, web-connected Linux server (VPS, VM, home server) where pasting an auth code back into the interactive terminal is painful or impossible (mobile SSH clients, web terminals with broken clipboards).

It's designed to run for minutes, not months: bring it up when you need to (re-)authenticate, and take it down when the token is minted. If you forget, it shuts itself down after 30 minutes of inactivity.

The pty-driving approach was verified end-to-end against Claude Code 2.1.200 (2026-07-03); the CLI's prompts and URLs can drift between releases, so the tested version is recorded here and should be re-checked after major CLI updates.

## How it works

1. You start the portal over SSH; it prompts you for a **one-time password for this run**, then prints an `https://<your-server-ip>:61897` URL and a certificate fingerprint.
2. From your phone/desktop browser you open that URL and enter the password — the password form is the only thing the site exposes.
3. The server spawns `claude /login` in a pseudo-terminal and extracts the OAuth URL it prints.
4. You open that URL, complete the Claude login in your browser, and get back a short code.
5. You paste that code into the portal, which feeds it back into the running `claude /login` process.
6. The portal confirms the CLI picked up a valid credential before reporting success, then you shut it down with one button (or it shuts itself down after 30 idle minutes).

No accounts, no stored secrets, no config: the password lives only in memory for that run and dies with the process.

## Setup

On a fresh Linux server that already has Claude Code installed:

```bash
curl -fsSL https://raw.githubusercontent.com/spfrood/claudetfawa/main/install.sh | bash
```

The installer adds Node.js and build tools if they're missing (the one step that needs sudo) and installs the app. Prefer not to pipe curl into bash? The equivalent manual steps:

```bash
git clone https://github.com/spfrood/claudetfawa ~/claudetfawa
cd ~/claudetfawa
npm install
```

Then, each time you need to authenticate:

```bash
node server.js   # prompts for a password, prints the URL + cert fingerprint
```

Depending on your provider and distro, you may need to temporarily allow inbound TCP on the port (default `61897`):

- **Provider layer**: AWS/GCP/Azure/Oracle block inbound by default and need a security-group rule (close it again when you're done); some providers (e.g. SSD Nodes) don't filter inbound traffic at all.
- **OS layer**: Fedora/RHEL-family ships with `firewalld` active — `sudo firewall-cmd --add-port=61897/tcp` opens it for the current boot only (no `--permanent`), which suits a temporary portal: the rule cleans itself up on reboot. Ubuntu images with `ufw` active need `sudo ufw allow 61897/tcp` (and `sudo ufw delete allow 61897/tcp` afterward).

The portal assumes it may be internet-facing either way — that's what the rate limiting, fail-closed shutdown, and short lifetime are for.

### Browser notes (phones especially)

- Type the URL **with the `https://` prefix**. A bare `1.2.3.4:61897` is treated as `http://`, which the portal doesn't speak — and browsers with HTTPS-Only settings will refuse it with a confusing error.
- **iOS Safari with HTTPS-Only mode enabled** can refuse the self-signed certificate outright ("network connection was lost") instead of showing the usual warning page. Use another browser (Chrome on iOS works) or temporarily disable that Safari setting.
- The certificate warning itself is expected: verify the SHA-256 fingerprint the browser shows against the one printed in your terminal, then proceed (on iOS: Show Details → visit this website).

## Stack

- Node.js + Express, with built-in self-signed TLS (no reverse proxy or domain needed)
- `node-pty` (to give the CLI a real pseudo-terminal — plain piped stdio doesn't reliably deliver input to Claude Code's TUI)
- `express-session` for short-lived, fixed-expiry sessions
- `bcrypt` for verifying the launch-time password (held in memory only)
- `express-rate-limit` on the login endpoint

## Security model

- A fresh password every run, chosen at launch (minimum 12 characters), bcrypt-hashed in memory, never written to disk, never passed via flag or environment variable. Whoever passes the password form can mint Claude credentials on your server, so for the minutes the portal is up, that password **is** the perimeter — use a strong throwaway passphrase.
- Short exposure window: the portal only runs while you're actively authenticating and exits after 30 minutes of inactivity. Unauthenticated requests (port scanners, failed logins) don't reset that timer.
- Fail-closed under attack: after 20 failed password attempts (cumulative, any IP), the portal shuts itself down. Relaunch with a new password takes seconds.
- Login attempts are rate-limited per IP and failures return a generic error.
- The unauthenticated surface is a single minimal password form — nothing that advertises what the portal does.
- Self-signed TLS with the certificate fingerprint printed in your SSH terminal at startup, so you can verify it against the browser's warning and detect a man-in-the-middle.
- Sessions are short-lived (15 minutes, fixed, no extension on activity) and the session secret is regenerated every run.
- Every exit path (shutdown button, Ctrl-C, inactivity timeout, fail-closed shutdown) kills any running `claude /login` process and closes the listener.

## Status

Working. Verified end-to-end on 2026-07-05 on two fresh VPSes — Ubuntu (apt) and Fedora 44 (dnf/firewalld) — each with never-run Claude Code 2.1.200: one-line install, full OAuth completed from an iPhone browser, CLI authenticated and usable afterward. Claude Code's TUI screens can drift between releases — if the portal reports an unrecognized screen, file an issue with the output it shows.
