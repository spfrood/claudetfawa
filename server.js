#!/usr/bin/env node
'use strict';

// claudetfawa — temporary web portal for completing `claude /login` on a
// headless server. Ephemeral by design: password chosen at launch (memory
// only), self-signed TLS, and it exits on its own after enough inactivity
// or failed logins. See BUILD_DOC.md for the full spec.

const os = require('os');
const https = require('https');
const crypto = require('crypto');

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const selfsigned = require('selfsigned');

const { LoginDriver, credentialsPath } = require('./lib/pty-driver');
const pages = require('./lib/pages');

function intEnv(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const PORT = parseInt(argValue('--port') || process.env.PORT || '61897', 10);
const BIND = argValue('--bind') || process.env.BIND || '0.0.0.0';
// Env overrides exist so tests can run in seconds; defaults are the spec.
const IDLE_SHUTDOWN_SECS = intEnv('IDLE_SHUTDOWN_SECS', 30 * 60);
const SESSION_TTL_SECS = intEnv('SESSION_TTL_SECS', 15 * 60);
const PTY_TIMEOUT_SECS = intEnv('PTY_TIMEOUT_SECS', 5 * 60);
const RATE_LIMIT_MAX = intEnv('RATE_LIMIT_MAX', 5);
const FAIL_CLOSE_MAX = intEnv('FAIL_CLOSE_MAX', 20);
const MIN_PASSWORD_LEN = 12;

function log(msg) {
  console.log(`[claudetfawa] ${msg}`);
}

// ---------------------------------------------------------------------------
// Launch-time password: masked terminal input, interactive only. No flag, no
// env var — nothing that could land in shell history or /proc/<pid>/environ.
function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') { // Ctrl-C
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function collectPassword() {
  if (!process.stdin.isTTY) {
    console.error('claudetfawa must be run interactively (it prompts for a password). Use tmux for flaky connections.');
    process.exit(1);
  }
  for (;;) {
    const pw = await promptHidden(`Choose a password for this run (min ${MIN_PASSWORD_LEN} chars): `);
    if (pw.length < MIN_PASSWORD_LEN) {
      console.log(`Too short — ${MIN_PASSWORD_LEN} characters minimum.`);
      continue;
    }
    const confirm = await promptHidden('Confirm password: ');
    if (pw !== confirm) {
      console.log('Passwords do not match, try again.');
      continue;
    }
    return pw;
  }
}

// ---------------------------------------------------------------------------
function makeCert() {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'claudetfawa' }], {
    days: 7,
    keySize: 2048,
    algorithm: 'sha256',
  });
  const der = Buffer.from(
    pems.cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''),
    'base64'
  );
  const fingerprint = crypto
    .createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)
    .join(':');
  return { key: pems.private, cert: pems.cert, fingerprint };
}

function externalAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
async function main() {
  const password = await collectPassword();
  const passwordHash = await bcrypt.hash(password, 12);
  // Best effort at dropping the plaintext; the hash is what we keep.

  const tls = makeCert();
  const sessionSecret = crypto.randomBytes(48).toString('hex');

  const state = {
    lastActivity: Date.now(), // reset only by *authenticated* requests
    failedLogins: 0,
    driver: null,
    snapshot: { state: 'idle', message: 'No login attempt started yet.', url: null, tail: null },
  };
  const sseClients = new Set();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(
    session({
      name: 'sid',
      secret: sessionSecret,
      resave: false,
      rolling: false, // fixed expiry: activity must NOT extend the session
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: SESSION_TTL_SECS * 1000,
      },
    })
  );

  const loginLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: RATE_LIMIT_MAX,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).send(pages.loginPage(true)),
  });

  // Fixed session lifetime, enforced by timestamp: express-session touches the
  // store on every request even with rolling:false, which would quietly turn
  // the cookie's fixed expiry into a rolling one.
  function sessionFresh(req) {
    const s = req.session;
    return !!(s && s.authenticated && typeof s.createdAt === 'number' && Date.now() - s.createdAt <= SESSION_TTL_SECS * 1000);
  }

  function requireAuth(req, res, next) {
    if (sessionFresh(req)) {
      state.lastActivity = Date.now();
      return next();
    }
    if (req.session && req.session.authenticated) req.session.destroy(() => {});
    if (req.method === 'GET') return res.redirect('/');
    return res.status(401).json({ error: 'unauthenticated' });
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {}
    }
  }

  // ---- shutdown machinery --------------------------------------------------
  let shuttingDown = false;
  function shutdown(reason, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down: ${reason}`);
    broadcast('shutdown', { reason });
    if (state.driver) {
      try {
        state.driver.dispose();
      } catch {}
    }
    for (const res of sseClients) {
      try {
        res.end();
      } catch {}
    }
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 1500).unref();
  }
  process.on('SIGINT', () => shutdown('interrupted (Ctrl-C)'));
  process.on('SIGTERM', () => shutdown('terminated'));
  process.on('uncaughtException', (err) => {
    console.error(err);
    shutdown('crashed', 1);
  });

  // Unauthenticated traffic (scanners, failed logins) must not keep the
  // portal alive — only requireAuth() above touches lastActivity.
  setInterval(() => {
    if (Date.now() - state.lastActivity > IDLE_SHUTDOWN_SECS * 1000) {
      shutdown(`no authenticated activity for ${IDLE_SHUTDOWN_SECS}s`);
    }
  }, 2000).unref();

  // ---- routes ---------------------------------------------------------------
  app.get('/', (req, res) => {
    if (sessionFresh(req)) return res.redirect('/dashboard');
    res.send(pages.loginPage('e' in req.query));
  });

  app.post('/login', loginLimiter, async (req, res) => {
    const candidate = typeof req.body.password === 'string' ? req.body.password : '';
    const ok = await bcrypt.compare(candidate, passwordHash);
    if (ok) {
      req.session.authenticated = true;
      req.session.createdAt = Date.now();
      state.lastActivity = Date.now();
      return res.redirect('/dashboard');
    }
    state.failedLogins += 1;
    log(`Failed login attempt ${state.failedLogins}/${FAIL_CLOSE_MAX} from ${req.ip}`);
    if (state.failedLogins >= FAIL_CLOSE_MAX) {
      res.status(429).send(pages.loginPage(true));
      // Single factor on a public port: the correct response to a determined
      // guesser is to stop existing. Relaunching takes seconds.
      return shutdown(`${FAIL_CLOSE_MAX} failed login attempts — assuming brute force`, 2);
    }
    res.redirect('/?e=1');
  });

  app.get('/dashboard', requireAuth, (req, res) => res.send(pages.dashboardPage()));

  app.get('/status', requireAuth, (req, res) => res.json(state.snapshot));

  app.get('/events', requireAuth, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(`event: status\ndata: ${JSON.stringify(state.snapshot)}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {}
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  app.post('/start-login', requireAuth, (req, res) => {
    if (state.driver && state.driver.alive) state.driver.dispose();
    const driver = new LoginDriver({ ptyTimeoutSecs: PTY_TIMEOUT_SECS });
    state.driver = driver;
    driver.on('update', (status) => {
      state.snapshot = status;
      broadcast('status', status);
    });
    driver.on('success', () => log('Login verified — new credentials on disk.'));
    driver.on('failed', (why) => log(`Login attempt failed: ${why}`));
    driver.start();
    res.json({ ok: true });
  });

  app.post('/submit-code', requireAuth, (req, res) => {
    const code = typeof req.body.code === 'string' ? req.body.code : '';
    if (!state.driver || !state.driver.writeCode(code)) {
      return res.status(409).json({ error: 'no login process waiting for a code' });
    }
    res.json({ ok: true });
  });

  app.post('/shutdown', requireAuth, (req, res) => {
    res.json({ ok: true });
    setTimeout(() => shutdown('user requested shutdown from dashboard'), 200);
  });

  app.use((req, res) => res.status(404).send('Not found'));

  const server = https.createServer({ key: tls.key, cert: tls.cert }, app);
  server.listen(PORT, BIND, () => {
    const addrs = externalAddresses();
    log(`listening on ${BIND}:${PORT}`);
    console.log('');
    console.log('  Open this in your phone/desktop browser:');
    for (const a of addrs) console.log(`    https://${a}:${PORT}`);
    if (!addrs.length) console.log(`    https://<this-server's-ip>:${PORT}`);
    console.log('');
    console.log("  (If those are private addresses, use the server's public IP —");
    console.log('  and make sure your cloud firewall / security group allows the port.)');
    console.log('');
    console.log('  The browser will warn about a self-signed certificate. Verify that the');
    console.log('  SHA-256 fingerprint it shows matches this one before proceeding:');
    console.log(`    ${tls.fingerprint}`);
    console.log('');
    log(`credentials target: ${credentialsPath()}`);
    log(`auto-shutdown after ${Math.round(IDLE_SHUTDOWN_SECS / 60)} min of inactivity; Ctrl-C to stop now`);
  });
  server.on('error', (err) => {
    console.error(`Could not listen on ${BIND}:${PORT}: ${err.message}`);
    process.exit(1);
  });
}

main();
