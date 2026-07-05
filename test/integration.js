'use strict';

// Integration test: launches the real server (in a pty, so the interactive
// password prompt is exercised) and drives it over HTTPS. Timer-dependent
// behaviors run with second-scale env overrides. The pty-driver scenario
// needs the `claude` binary and uses a scratch CLAUDE_CONFIG_DIR.
//
// Usage: node test/integration.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const pty = require('node-pty');

const SERVER = path.join(__dirname, '..', 'server.js');
const PASSWORD = 'correct-horse-battery';
let nextPort = 61890;
let failures = 0;

function ok(cond, label) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failures += 1;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- server harness --------------------------------------------------------
function launch(envOverrides = {}) {
  const port = nextPort++;
  const env = {
    ...process.env,
    PORT: String(port),
    BIND: '127.0.0.1',
    ...envOverrides,
  };
  const proc = pty.spawn('node', [SERVER], { name: 'xterm', cols: 120, rows: 40, cwd: path.dirname(SERVER), env });
  let output = '';
  let exited = null;
  const exitPromise = new Promise((resolve) => {
    proc.onExit(({ exitCode }) => {
      exited = exitCode;
      resolve(exitCode);
    });
  });
  proc.onData((d) => {
    output += d;
  });

  async function waitFor(needle, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (output.includes(needle)) return true;
      if (exited !== null) return false;
      await sleep(100);
    }
    return false;
  }

  return {
    port,
    proc,
    waitFor,
    exitPromise,
    get output() {
      return output;
    },
    get exited() {
      return exited;
    },
    kill() {
      if (exited === null) proc.kill();
    },
  };
}

async function launchAndLogin(envOverrides = {}) {
  const s = launch(envOverrides);
  await s.waitFor('Choose a password');
  s.proc.write(PASSWORD + '\r');
  await s.waitFor('Confirm password');
  s.proc.write(PASSWORD + '\r');
  const up = await s.waitFor('listening on');
  if (!up) throw new Error('server did not start:\n' + s.output);
  return s;
}

// ---- tiny https client with a cookie jar -----------------------------------
function makeClient(port) {
  let cookie = null;
  let lastCert = null;
  function request(method, reqPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
      const req = https.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: reqPath,
          rejectUnauthorized: false,
          headers: {
            ...(data ? { 'Content-Type': headers['Content-Type'] || 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          lastCert = res.socket.getPeerCertificate();
          const setCookie = res.headers['set-cookie'];
          if (setCookie && setCookie.length) cookie = setCookie[0].split(';')[0];
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
        }
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  return {
    get: (p) => request('GET', p),
    postForm: (p, form) => request('POST', p, form, { 'Content-Type': 'application/x-www-form-urlencoded' }),
    postJson: (p, obj) => request('POST', p, obj),
    clearCookie: () => {
      cookie = null;
    },
    peerCert: () => lastCert,
  };
}

async function login(client) {
  return client.postForm('/login', `password=${encodeURIComponent(PASSWORD)}`);
}

async function pollStatus(client, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await client.get('/status');
    if (r.status === 200) {
      last = JSON.parse(r.body);
      if (predicate(last)) return last;
    }
    await sleep(500);
  }
  throw new Error(`status predicate not met in time; last: ${JSON.stringify(last)}`);
}

// ---- scenarios --------------------------------------------------------------
async function scenarioAuth() {
  console.log('\n== auth basics, cert fingerprint ==');
  const s = await launchAndLogin();
  const c = makeClient(s.port);

  let r = await c.get('/');
  ok(r.status === 200 && r.body.includes('Password required'), 'unauthenticated GET / serves the password form');
  ok(!/claude/i.test(r.body), 'password form does not mention what it protects');

  r = await c.get('/dashboard');
  ok(r.status === 302 && r.headers.location === '/', 'unauthenticated GET /dashboard redirects to /');

  r = await c.postJson('/start-login', {});
  ok(r.status === 401, 'unauthenticated POST /start-login gets 401');

  r = await c.postForm('/login', 'password=wrong-password-here');
  ok(r.status === 302 && r.headers.location === '/?e=1', 'wrong password redirects with generic error flag');

  r = await login(c);
  ok(r.status === 302 && r.headers.location === '/dashboard', 'correct password redirects to dashboard');

  r = await c.get('/dashboard');
  ok(r.status === 200 && r.body.includes('claudetfawa'), 'authenticated GET /dashboard serves the app');

  r = await c.get('/status');
  const snap = JSON.parse(r.body);
  ok(r.status === 200 && snap.state === 'idle', 'GET /status shows idle snapshot');

  const printed = (s.output.match(/([0-9A-F]{2}:){31}[0-9A-F]{2}/) || [])[0];
  const cert = c.peerCert();
  const actual = cert && cert.fingerprint256;
  ok(!!printed && printed === actual, `printed cert fingerprint matches the one served (${(printed || '').slice(0, 20)}…)`);

  r = await c.postJson('/shutdown', {});
  ok(r.status === 200, 'POST /shutdown accepted');
  const code = await s.exitPromise;
  ok(code === 0, 'server exited cleanly after shutdown request');
}

async function scenarioSessionExpiry() {
  console.log('\n== fixed session expiry ==');
  const s = await launchAndLogin({ SESSION_TTL_SECS: '2', IDLE_SHUTDOWN_SECS: '60' });
  const c = makeClient(s.port);
  await login(c);
  let r = await c.get('/dashboard');
  ok(r.status === 200, 'session valid immediately after login');
  await sleep(1200);
  await c.get('/dashboard'); // activity — must NOT extend the fixed session
  await sleep(1500);
  r = await c.get('/dashboard');
  ok(r.status === 302, 'session expired at TTL despite intermediate activity (fixed, not rolling)');
  s.kill();
  await s.exitPromise;
}

async function scenarioRateLimit() {
  console.log('\n== per-IP rate limit ==');
  const s = await launchAndLogin({ RATE_LIMIT_MAX: '3' });
  const c = makeClient(s.port);
  for (let i = 0; i < 3; i++) await c.postForm('/login', 'password=nope-nope-nope');
  const r = await c.postForm('/login', 'password=nope-nope-nope');
  ok(r.status === 429, 'attempt past the limit gets 429');
  const r2 = await login(c);
  ok(r2.status === 429, 'even the correct password is refused while rate-limited');
  s.kill();
  await s.exitPromise;
}

async function scenarioFailClosed() {
  console.log('\n== fail-closed shutdown under brute force ==');
  const s = await launchAndLogin({ FAIL_CLOSE_MAX: '4', RATE_LIMIT_MAX: '100' });
  const c = makeClient(s.port);
  for (let i = 0; i < 4; i++) await c.postForm('/login', 'password=guess-number-' + i).catch(() => {});
  const code = await Promise.race([s.exitPromise, sleep(5000).then(() => 'timeout')]);
  ok(code === 2, `server shut itself down after 4 failures (exit code ${code})`);
}

async function scenarioIdleShutdown() {
  console.log('\n== inactivity self-shutdown; unauthenticated noise ignored ==');
  const s = await launchAndLogin({ IDLE_SHUTDOWN_SECS: '4', RATE_LIMIT_MAX: '100' });
  const c = makeClient(s.port);
  await login(c);
  const noise = makeClient(s.port);
  const start = Date.now();
  const poker = setInterval(() => {
    noise.get('/').catch(() => {});
    noise.postForm('/login', 'password=scanner-noise').catch(() => {});
  }, 700);
  const code = await Promise.race([s.exitPromise, sleep(12000).then(() => 'timeout')]);
  clearInterval(poker);
  const elapsed = (Date.now() - start) / 1000;
  ok(code === 0, 'server exited on idle timeout');
  ok(elapsed >= 3.5 && elapsed < 9, `exited ~4s after last authenticated request despite unauth noise (${elapsed.toFixed(1)}s)`);
}

async function scenarioDriverThroughWeb() {
  console.log('\n== full pty flow through the web API (scratch config, aborted before real auth) ==');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ctfawa-web-'));
  const s = await launchAndLogin({ CLAUDE_CONFIG_DIR: scratch, PTY_TIMEOUT_SECS: '120' });
  const c = makeClient(s.port);
  await login(c);

  let r = await c.postJson('/submit-code', { code: 'anything' });
  ok(r.status === 409, 'submit-code with no login process running gets 409');

  r = await c.postJson('/start-login', {});
  ok(r.status === 200, 'start-login accepted');

  const ready = await pollStatus(c, (st) => st.state === 'url-ready', 60000);
  ok(/^https:\/\/claude\.(com|ai)\/\S*oauth/.test(ready.url), `OAuth URL surfaced via /status (${ready.url.length} chars)`);
  ok(ready.url.length > 300 && ready.url.length < 600, 'URL length sane (no glued redraw copies)');

  r = await c.postJson('/submit-code', { code: 'A'.repeat(51) + '_' + 'b'.repeat(34) + '#' + 'x'.repeat(43) });
  ok(r.status === 200, 'submit-code accepted');
  await pollStatus(c, (st) => st.state === 'code-error', 30000);
  ok(true, 'CLI rejection surfaced as code-error');
  const again = await pollStatus(c, (st) => st.state === 'url-ready' && st.url !== ready.url, 30000);
  ok(again.url !== ready.url, 'fresh URL issued for retry');

  r = await c.postJson('/shutdown', {});
  const code = await s.exitPromise;
  ok(code === 0, 'clean shutdown with live pty');
  await sleep(1000);
  let leftovers = '';
  try {
    leftovers = require('child_process').execSync('pgrep -fa "claude /login" || true').toString();
  } catch {}
  leftovers = leftovers
    .split('\n')
    .filter((l) => l && !l.includes('pgrep'))
    .join('\n');
  ok(leftovers === '', 'no orphaned claude /login processes after shutdown');
}

async function scenarioShortPassword() {
  console.log('\n== password policy at launch ==');
  const s = launch();
  await s.waitFor('Choose a password');
  s.proc.write('short\r');
  const rejected = await s.waitFor('Too short');
  ok(rejected, 'password under 12 chars rejected at the prompt');
  s.proc.write(PASSWORD + '\r');
  await s.waitFor('Confirm password');
  s.proc.write('different-passphrase\r');
  const mismatch = await s.waitFor('do not match');
  ok(mismatch, 'mismatched confirmation rejected');
  s.kill();
  await s.exitPromise;
}

// ---- run --------------------------------------------------------------------
(async () => {
  try {
    await scenarioAuth();
    await scenarioShortPassword();
    await scenarioSessionExpiry();
    await scenarioRateLimit();
    await scenarioFailClosed();
    await scenarioIdleShutdown();
    await scenarioDriverThroughWeb();
  } catch (err) {
    console.error('\nUNEXPECTED ERROR:', err.message);
    failures += 1;
  }
  console.log(failures === 0 ? '\nALL SCENARIOS PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
