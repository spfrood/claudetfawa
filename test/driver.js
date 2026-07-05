'use strict';

// Live test of the pty driver against the locally installed `claude` binary.
// Uses a scratch CLAUDE_CONFIG_DIR so real credentials are never touched, and
// aborts before completing OAuth (submits a garbage code and expects the CLI
// to reject it). Run twice against the same scratch dir to cover both the
// never-run and run-but-never-authenticated install states.
//
// Usage: node test/driver.js [scratch-config-dir]

const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'ctfawa-test-'));
fs.mkdirSync(scratch, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = scratch;

const { LoginDriver } = require('../lib/pty-driver');

const stateLabel = fs.existsSync(path.join(scratch, 'settings.json'))
  ? 'run-but-never-authenticated'
  : 'never-run';
console.log(`config dir: ${scratch} (${stateLabel} state)`);

const driver = new LoginDriver({ ptyTimeoutSecs: 120, urlTimeoutSecs: 90, verifyTimeoutSecs: 30 });
let gotUrl = false;
let gotCodeError = false;
let gotFreshUrl = false;

const deadline = setTimeout(() => {
  console.error('FAIL: timed out. Last status:', driver.status.state, '-', driver.status.message);
  if (driver.status.tail) console.error('tail:', driver.status.tail.slice(-500));
  driver.dispose();
  process.exit(1);
}, 120000);

driver.on('update', (s) => console.log(`  [${s.state}] ${s.message}`));

driver.on('url', (url) => {
  if (!gotUrl) {
    gotUrl = true;
    console.log(`PASS: OAuth URL extracted (${url.length} chars): ${url.slice(0, 80)}…`);
    setTimeout(() => {
      console.log('  submitting garbage code, expecting rejection…');
      // Realistic length matters: long pastes trip the TUI's paste-burst
      // handling (short fakes masked a real bug here once already).
      const fakeCode = 'A'.repeat(20) + '-' + 'b'.repeat(30) + '_' + 'C'.repeat(34) + '#' + 'x'.repeat(43);
      if (!driver.writeCode(fakeCode)) {
        console.error('FAIL: writeCode refused input');
        process.exit(1);
      }
    }, 1000);
  } else if (gotCodeError && !gotFreshUrl) {
    gotFreshUrl = true;
    console.log('PASS: fresh URL issued after rejected code (retry path works)');
    finish();
  }
});

driver.on('update', (s) => {
  if (s.state === 'code-error' && !gotCodeError) {
    gotCodeError = true;
    console.log('PASS: CLI rejected the garbage code and the driver surfaced it');
  }
});

driver.on('failed', (why) => {
  console.error(`FAIL: driver failed: ${why}`);
  process.exit(1);
});

function finish() {
  clearTimeout(deadline);
  driver.dispose();
  setTimeout(() => {
    const ok = gotUrl && gotCodeError && gotFreshUrl;
    console.log(ok ? `\nALL PASS (${stateLabel})` : '\nFAIL: missing expectations');
    process.exit(ok ? 0 : 1);
  }, 1000);
}

driver.start();
