'use strict';

// Inline HTML for the portal's three surfaces. No framework, no build step,
// no external assets — everything a phone browser needs is in the response.

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #14161a; color: #e6e3da; font: 16px/1.5 system-ui, sans-serif; }
  .card { width: min(30rem, calc(100vw - 2rem)); padding: 1.5rem; background: #1d2026;
          border: 1px solid #30343d; border-radius: 12px; }
  h1 { font-size: 1.15rem; margin: 0 0 1rem; }
  input[type=password], input[type=text] { width: 100%; padding: .65rem .75rem; font-size: 1rem;
          background: #14161a; color: inherit; border: 1px solid #3a3f4a; border-radius: 8px; }
  button { padding: .65rem 1rem; font-size: 1rem; border: 0; border-radius: 8px; cursor: pointer;
           background: #c96f4a; color: #14161a; font-weight: 600; }
  button.secondary { background: #30343d; color: #e6e3da; }
  button.danger { background: #8c3a3a; color: #f2e8e8; }
  button:disabled { opacity: .45; cursor: default; }
  .err { color: #e08e8e; margin: .75rem 0 0; }
  .muted { color: #9aa0ab; font-size: .875rem; }
  .row { display: flex; gap: .75rem; margin-top: 1rem; flex-wrap: wrap; }
  #status { margin: 1rem 0; padding: .75rem; background: #14161a; border-radius: 8px; }
  a.oauth { display: block; margin: 1rem 0; padding: .9rem; text-align: center; background: #2a4a3d;
            color: #bfe8cf; border-radius: 8px; font-weight: 600; word-break: break-all;
            text-decoration: none; }
  pre#tail { white-space: pre-wrap; word-break: break-all; font-size: .75rem; color: #9aa0ab;
             background: #14161a; padding: .75rem; border-radius: 8px; max-height: 14rem; overflow-y: auto; }
  .hidden { display: none; }
  ul { padding-left: 1.2rem; } li { margin: .35rem 0; }
`;

// Deliberately unbranded: nothing here tells a scanner what this protects.
function loginPage(error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>&#8226;&#8226;&#8226;</title>
<style>${CSS}</style></head><body>
<div class="card"><h1>Password required</h1>
<form method="post" action="/login">
  <input type="password" name="password" autofocus autocomplete="current-password" aria-label="Password">
  <div class="row"><button type="submit">Enter</button></div>
</form>
${error ? '<p class="err">Invalid password.</p>' : ''}
</div></body></html>`;
}

function dashboardPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>claudetfawa</title>
<style>${CSS}</style></head><body>
<div class="card">
  <h1>claudetfawa &mdash; Claude Code login</h1>
  <div id="status" class="muted">Connecting&hellip;</div>
  <a id="oauthlink" class="oauth hidden" target="_blank" rel="noopener"></a>
  <form id="codeform" class="hidden">
    <label class="muted" for="code">Paste the code from the sign-in page:</label>
    <input type="text" id="code" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="row"><button type="submit" id="codebtn">Submit code</button></div>
  </form>
  <div id="successbox" class="hidden">
    <p><strong>Done — Claude Code on this server is authenticated.</strong></p>
    <ul class="muted">
      <li>Any Claude Code process already running (e.g. in tmux) must be restarted to pick up the new token.</li>
      <li>If you opened a firewall / security-group rule for this portal, close it now.</li>
      <li>Shut the portal down below — it has no other purpose.</li>
    </ul>
  </div>
  <pre id="tail" class="hidden"></pre>
  <div class="row">
    <button id="start" class="secondary" disabled>Start Claude login</button>
    <button id="shutdown" class="danger">Shut down portal</button>
  </div>
  <p class="muted" id="footnote">Session and portal both expire on their own; the shutdown button is faster.</p>
</div>
<script>
(function () {
  var el = function (id) { return document.getElementById(id); };
  var dead = false;

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (r.status === 401) { location.href = '/'; throw new Error('unauthenticated'); }
      return r;
    });
  }

  function show(id, on) { el(id).classList.toggle('hidden', !on); }

  function render(s) {
    if (dead) return;
    el('status').textContent = s.message || s.state;
    var busy = s.state === 'starting' || s.state === 'answering' || s.state === 'verifying';
    el('start').disabled = busy;
    el('start').textContent = (s.state === 'idle') ? 'Start Claude login' : 'Restart Claude login';
    show('oauthlink', !!s.url && s.state !== 'success' && s.state !== 'failed');
    if (s.url) { el('oauthlink').href = s.url; el('oauthlink').textContent = 'Open Claude sign-in page'; }
    show('codeform', !!s.url && (s.state === 'url-ready' || s.state === 'code-error'));
    show('successbox', s.state === 'success');
    show('tail', s.state === 'failed' && !!s.tail);
    if (s.tail) el('tail').textContent = s.tail;
    if (s.state === 'success') { show('oauthlink', false); show('codeform', false); }
  }

  function connect() {
    var es = new EventSource('/events');
    es.addEventListener('status', function (ev) { render(JSON.parse(ev.data)); });
    es.addEventListener('shutdown', function () {
      dead = true; es.close();
      el('status').textContent = 'Portal has shut down. You can close this tab.';
      ['start', 'shutdown', 'codebtn'].forEach(function (id) { el(id).disabled = true; });
    });
    es.onerror = function () {
      if (dead) return;
      es.close();
      el('status').textContent = 'Connection lost (session may have expired). Reload the page.';
    };
  }

  el('start').addEventListener('click', function () {
    el('start').disabled = true;
    post('/start-login').catch(function () {});
  });

  el('codeform').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var code = el('code').value.trim();
    if (!code) return;
    el('codebtn').disabled = true;
    post('/submit-code', { code: code }).then(function () {
      el('code').value = '';
      el('codebtn').disabled = false;
    }).catch(function () { el('codebtn').disabled = false; });
  });

  el('shutdown').addEventListener('click', function () {
    if (!confirm('Shut down the portal?')) return;
    post('/shutdown').catch(function () {});
  });

  fetch('/status').then(function (r) {
    if (r.status === 401) { location.href = '/'; return null; }
    return r.json();
  }).then(function (s) { if (s) { render(s); el('start').disabled = false; connect(); } });
})();
</script>
</body></html>`;
}

module.exports = { loginPage, dashboardPage };
