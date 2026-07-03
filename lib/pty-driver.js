'use strict';

// Drives `claude /login` inside a pseudo-terminal.
//
// Claude Code's TUI is Ink-based and needs a real pty: plain piped stdio does
// not reliably deliver input to its raw-mode prompt. Verified against Claude
// Code 2.1.200 (2026-07-03) in all three install states (never-run,
// run-but-never-authenticated, previously-authenticated). See BUILD_DOC.md
// "PTY driver" for the empirical requirements this implements.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pty = require('node-pty');

// strip-ansi's pattern, inlined: strip-ansi v7+ is ESM-only, which breaks
// require() on older Node 20 patch releases.
const ANSI_RE = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  'g'
);
const stripAnsi = (s) => s.replace(ANSI_RE, '');

// The OAuth URL specifically — a bare https://\S+ would also match promo and
// help links in the TUI banner. claude.com as of 2.1.200; .ai kept for drift.
const URL_RE = /https:\/\/claude\.(?:com|ai)\/\S*oauth\S+/g;

// Interactive screens that can precede the URL, varying with install state.
// Detection runs on whitespace-stripped lowercase text because Ink positions
// text with cursor movements, so ANSI-stripped output loses its spaces.
// Every screen's default choice is the correct one — a single Enter advances.
// Patterns must be specific to each chooser screen: e.g. "Syntax theme: …" is
// a persistent status line that lingers on later screens, so the theme prompt
// matches only the chooser's own question text.
const PROMPTS = [
  { key: 'theme', re: /choosethetextstyle/, message: 'Answering first-run theme prompt…' },
  { key: 'trust', re: /trustthisfolder|doyoutrustthefiles/, message: 'Answering workspace-trust prompt…' },
  { key: 'method', re: /selectloginmethod/, message: 'Selecting subscription login…' },
];

const CODE_ERROR_RE = /oautherror|invalidcode/;
const SUCCESS_HINT_RE = /loginsuccessful|loggedinas|successfullyloggedin/;

function credentialsPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, '.credentials.json');
}

function hasAccessToken(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'accessToken' && typeof v === 'string' && v.length > 0) return true;
    if (typeof v === 'object' && hasAccessToken(v)) return true;
  }
  return false;
}

class LoginDriver extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.claudeBin = opts.claudeBin || 'claude';
    this.ptyTimeoutMs = (opts.ptyTimeoutSecs || 300) * 1000;
    this.urlTimeoutMs = (opts.urlTimeoutSecs || 90) * 1000;
    this.verifyTimeoutMs = (opts.verifyTimeoutSecs || 60) * 1000;
    this.credsPath = credentialsPath();

    this.raw = '';
    this.url = null;
    this.alive = false;
    this.finished = false;
    this.handled = {};
    this.searchFrom = {}; // per-prompt offset into the flattened output
    this.codeSubmitted = false;
    this.errorOffset = 0;
    this.errorEmitted = false;
    this.status = { state: 'idle', message: 'Not started.', url: null, tail: null };
  }

  start() {
    this.baselineCreds = this.readCreds();

    // Behave like a fresh terminal, not a nested Claude Code session.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;

    // 500 cols so Ink never wraps the ~450-char OAuth URL across lines.
    this.pty = pty.spawn(this.claudeBin, ['/login'], {
      name: 'xterm-256color',
      cols: 500,
      rows: 50,
      cwd: os.homedir(),
      env,
    });
    this.alive = true;
    this.touch();
    this.setStatus('starting', 'Started claude /login, waiting for its first screen…');

    this.pty.onData((d) => this.onData(d));
    this.pty.onExit(({ exitCode }) => this.onExit(exitCode));

    this.urlDeadline = setTimeout(() => {
      if (!this.url && this.alive && !this.finished) {
        this.fail('Timed out waiting for the OAuth URL — the CLI may have shown a screen this tool does not recognize (version drift?). Raw output below.');
      }
    }, this.urlTimeoutMs);

    this.idleCheck = setInterval(() => {
      if (this.alive && !this.finished && Date.now() - this.lastActivity > this.ptyTimeoutMs) {
        this.fail('The claude /login process went idle past the timeout.');
      }
    }, 5000);
  }

  onData(chunk) {
    this.raw += chunk;
    this.touch();
    const plain = stripAnsi(this.raw);
    const flat = plain.replace(/\s+/g, '').toLowerCase();

    for (const p of PROMPTS) {
      if (!this.handled[p.key] && p.re.test(flat.slice(this.searchFrom[p.key] || 0))) {
        this.handled[p.key] = true;
        this.answerDefault(p.message);
      }
    }

    // TUI redraws can append a second copy of the URL with no whitespace in
    // between (cursor moves, not spaces, separate them). Split any glued-
    // together matches back apart and take the newest genuine URL.
    const urls = plain.match(URL_RE);
    if (urls) {
      const candidates = [];
      for (const m of urls) {
        for (const seg of m.split(/(?=https:\/\/)/)) {
          if (seg.includes('oauth')) candidates.push(seg.replace(/[^\w\-.~%&=+?/:#]+$/, ''));
        }
      }
      const latest = candidates[candidates.length - 1];
      if (latest && latest !== this.url) {
        this.url = latest;
        clearTimeout(this.urlDeadline);
        this.setStatus('url-ready', 'OAuth URL ready — open it, sign in, then paste the code back here.', { url: latest });
        this.emit('url', latest);
      }
    }

    if (this.codeSubmitted && !this.finished) {
      const sinceSubmit = flat.slice(this.errorOffset);
      if (!this.errorEmitted && CODE_ERROR_RE.test(sinceSubmit)) {
        this.errorEmitted = true;
        this.setStatus('code-error', 'The CLI rejected that code. A fresh sign-in link is being issued — use the new link and paste the new code.');
        // The error screen says "Press Enter to retry"; doing so loops back to
        // the login-method selector, so re-arm that prompt — but only for
        // occurrences rendered after this point, or the old screens still in
        // the buffer would re-trigger it instantly.
        this.handled.method = false;
        this.searchFrom.method = flat.length;
        this.answerDefault(null);
      }
      if (SUCCESS_HINT_RE.test(sinceSubmit)) this.checkCredentials();
    }
  }

  // Every known screen's default option is correct; a lone Enter advances.
  // Small delay lets Ink finish drawing before it reads input.
  answerDefault(message) {
    if (message) this.setStatus('answering', message);
    setTimeout(() => {
      if (this.alive) {
        this.pty.write('\r');
        this.touch();
      }
    }, 400);
  }

  writeCode(code) {
    if (!this.alive || !this.url || this.finished) return false;
    const cleaned = String(code).replace(/\s+/g, '');
    if (!cleaned) return false;
    this.codeSubmitted = true;
    this.errorEmitted = false;
    this.errorOffset = stripAnsi(this.raw).replace(/\s+/g, '').length;
    this.setStatus('verifying', 'Code submitted — waiting for the CLI to verify and write credentials…');
    this.pty.write(cleaned + '\r');
    this.touch();
    this.startCredentialsPoll();
    return true;
  }

  // The authoritative success signal is the credentials file changing and
  // containing a non-empty accessToken — never the process's own claims.
  startCredentialsPoll() {
    if (this.credsPoll) clearInterval(this.credsPoll);
    const deadline = Date.now() + this.verifyTimeoutMs;
    this.credsPoll = setInterval(() => {
      if (this.finished || !this.alive) return clearInterval(this.credsPoll);
      if (this.checkCredentials()) return;
      if (Date.now() > deadline && !this.errorEmitted) {
        clearInterval(this.credsPoll);
        this.fail('The CLI accepted input but no new credentials appeared within the verification window.');
      }
    }, 1000);
  }

  checkCredentials() {
    const cur = this.readCreds();
    if (cur === null || cur === this.baselineCreds) return false;
    let parsed;
    try {
      parsed = JSON.parse(cur);
    } catch {
      return false;
    }
    if (!hasAccessToken(parsed)) return false;
    this.finished = true;
    this.cleanupTimers();
    this.setStatus('success', 'Login verified: new credentials with an access token are on disk.');
    this.emit('success');
    this.kill();
    return true;
  }

  fail(message) {
    if (this.finished) return;
    this.finished = true;
    this.cleanupTimers();
    this.setStatus('failed', message, { tail: this.tail() });
    this.emit('failed', message);
    this.kill();
  }

  onExit(exitCode) {
    this.alive = false;
    this.cleanupTimers();
    if (!this.finished) {
      this.finished = true;
      this.setStatus('failed', `claude /login exited unexpectedly (code ${exitCode}).`, { tail: this.tail() });
      this.emit('failed', 'unexpected exit');
    }
    this.emit('exit', exitCode);
  }

  kill() {
    this.cleanupTimers();
    if (this.pty && this.alive) {
      try {
        this.pty.kill();
      } catch {}
    }
  }

  // Deliberate teardown (shutdown, restart, test cleanup): kill the pty
  // without the unexpected-exit path reporting it as a failure.
  dispose() {
    this.finished = true;
    this.kill();
  }

  cleanupTimers() {
    clearTimeout(this.urlDeadline);
    clearInterval(this.idleCheck);
    clearInterval(this.credsPoll);
  }

  touch() {
    this.lastActivity = Date.now();
  }

  setStatus(state, message, extra = {}) {
    this.status = { ...this.status, state, message, ...extra };
    this.emit('update', this.status);
  }

  // Last stretch of cleaned output, for the visible-failure fallback.
  tail() {
    return stripAnsi(this.raw).replace(/\s+/g, ' ').slice(-1500);
  }

  readCreds() {
    try {
      return fs.readFileSync(this.credsPath, 'utf8');
    } catch {
      return null;
    }
  }
}

module.exports = { LoginDriver, stripAnsi, credentialsPath };
