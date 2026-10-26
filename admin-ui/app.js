// PSArelay admin console — no framework, no build step. Every value from
// the server is inserted as text (never as HTML).
'use strict';

const app = document.getElementById('app');
let me = null;
// The release this page's code came from; the server sends its own with every
// API answer. Different = a deploy happened while this tab was open.
const LOADED_VERSION = (document.querySelector('meta[name="psarelay-version"]') || {}).content || '';
let reloadShown = false;
function checkVersion(res) {
  const v = res.headers.get('X-PSArelay-Version');
  if (!v || !LOADED_VERSION || v === LOADED_VERSION || reloadShown) return;
  reloadShown = true;
  document.body.append(h('div', { class: 'reload-bar', role: 'status' },
    `Version ${v} was deployed (this page is ${LOADED_VERSION}). `,
    h('button', { class: 'small primary', onclick: () => location.reload() }, 'Reload')));
}
let refreshTimer = null;

// ── tiny DOM helper ───────────────────────────────────────────────────────
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, so the strict CSP (no inline style attributes) allows it
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
/** replaceChildren that skips null / false like h() does (replaceChildren would print "null"). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
function duration(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`;
}
function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

// ── API ───────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-PSArelay': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  checkVersion(res);
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me/password') { me = null; render(); throw new Error(data.error || 'Signed out.'); }
  if (res.status === 403 && data.code === 'password_change_required') { me = { ...(me || {}), mustChangePassword: true }; render(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ── shell ─────────────────────────────────────────────────────────────────
const ROUTES = [
  { hash: '#/', label: 'Dashboard', view: dashboard },
  { hash: '#/calls', label: 'Calls', view: calls },
  { hash: '#/actors', label: 'Actors', view: actors },
  { hash: '#/requests', label: 'Requests', view: requests },
  { hash: '#/bulk', label: 'Bulk jobs', view: bulk },
  { hash: '#/connect', label: 'Connect', view: connect },
  { hash: '#/setup', label: 'Setup', view: setup },
  { hash: '#/plan', label: 'Plan', view: planView },
  { hash: '#/notifications', label: 'Notifications', view: notifications },
  { hash: '#/settings', label: 'Settings', view: settings },
  { hash: '#/access', label: 'Access', view: access, admin: true },
  { hash: '#/users', label: 'Users', view: users, admin: true },
  { hash: '#/activity', label: 'Activity', view: activity, admin: true },
  { hash: '#/account', label: 'Account', view: account },
];

function shell(active, content) {
  return h('div', null,
    h('header', { class: 'top' }, h('div', { class: 'top-inner' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'PSArelay'),
      h('nav', null, ROUTES.filter((r) => !r.admin || me.role === 'admin').map((r) =>
        h('a', { href: r.hash, class: r.hash === active ? 'active' : null }, r.label))),
      h('div', { class: 'who' },
        h('span', { class: 'name muted' }, me.username),
        h('span', { class: `badge ${me.role === 'admin' ? 'accent' : ''}` }, me.role === 'admin' ? 'Admin' : 'Read-only'),
        h('button', { class: 'small', onclick: logout }, 'Sign out')))),
    planStrip(),
    h('main', null, content));
}

// Free trial / read-only plan: a strip on every page with what's left and the way to a plan.
let planInfo = null;
function planStrip() {
  const p = planInfo;
  if (!p || (!p.trial && !p.readOnly)) return null;
  const ended = p.mode === 'expired';
  const msg = ended ? (p.trial ? 'Your free trial has ended. PSArelay is locked until you choose a plan; your setup is kept.' : p.detail)
    : p.trial ? `${p.detail} Tools that change Autotask are locked until you choose a plan.` : p.detail;
  return h('div', { class: `plan-strip ${ended ? 'bad' : 'warn'}` }, h('div', { class: 'top-inner' },
    h('span', null, msg),
    location.hash === '#/plan' ? null : h('button', { class: 'small primary', onclick: () => { location.hash = '#/plan'; } }, 'Choose a plan')));
}

async function render() {
  clearInterval(refreshTimer);
  if (!me) return loginView();
  if (me.mustChangePassword) return changePasswordView(true);
  const route = ROUTES.find((r) => r.hash === (location.hash || '#/')) || ROUTES[0];
  if (route.admin && me.role !== 'admin') { location.hash = '#/'; return; }
  const body = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  try { planInfo = await api('GET', '/api/plan'); } catch { planInfo = null; }
  app.replaceChildren(shell(route.hash, body));
  try { await route.view(body); } catch (e) { body.replaceChildren(h('div', { class: 'banner bad' }, e.message)); }
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* ignore */ }
  me = null;
  location.hash = '#/';
  render();
}

// ── sign in / password ────────────────────────────────────────────────────
function loginView() {
  const err = h('p', { class: 'error', role: 'alert' });
  const user = h('input', { type: 'text', id: 'u', autocomplete: 'username', required: true, autofocus: true });
  const pass = h('input', { type: 'password', id: 'p', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'primary login-submit', type: 'submit' }, 'Sign in');
  // Show / hide the password (a button, so it is reachable by keyboard and announced).
  const peek = h('button', { type: 'button', class: 'login-peek', 'aria-label': 'Show password', 'aria-pressed': 'false', onclick: () => {
    const show = pass.type === 'password'; pass.type = show ? 'text' : 'password';
    peek.textContent = show ? 'Hide' : 'Show'; peek.setAttribute('aria-pressed', String(show)); peek.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); pass.focus();
  } }, 'Show');
  const form = h('form', { class: 'login-card', 'aria-labelledby': 'login-title', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
    try { me = (await api('POST', '/api/login', { username: user.value.trim(), password: pass.value })).user; render(); }
    catch (x) { err.textContent = x.message; pass.value = ''; pass.focus(); }
    finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  } },
    h('h1', { id: 'login-title' }, 'Sign in'),
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), h('div', { class: 'login-pass' }, pass, peek)),
    btn, err);
  app.replaceChildren(h('main', { class: 'login-wrap' }, h('div', { class: 'login' },
    h('div', { class: 'login-brand' }, h('img', { src: '/favicon.svg', alt: '' }), h('span', null, 'PSA', h('strong', null, 'relay'))),
    h('p', { class: 'login-tagline' }, 'Your Autotask, relayed to AI and automation — safely.'),
    form,
    h('p', { class: 'login-foot' }, h('a', { href: 'https://docs.psarelay.app', target: '_blank', rel: 'noopener noreferrer' }, 'Documentation'), ' · ', h('a', { href: 'https://github.com/GDSTechnology/psarelay', target: '_blank', rel: 'noopener noreferrer' }, 'Open source')))));
  user.focus();
}

function passwordForm(onDone, forced) {
  const err = h('p', { class: 'error', role: 'alert' });
  const cur = h('input', { type: 'password', id: 'cur', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', id: 'new', autocomplete: 'new-password', required: true, minlength: 12 });
  const nw2 = h('input', { type: 'password', id: 'new2', autocomplete: 'new-password', required: true });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Change password');
  return h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (nw.value !== nw2.value) { err.textContent = 'The new passwords do not match.'; return; }
    btn.disabled = true;
    try { me = (await api('POST', '/api/me/password', { currentPassword: cur.value, newPassword: nw.value })).user; onDone(); }
    catch (x) { err.textContent = x.message; }
    finally { btn.disabled = false; }
  } },
    h('div', { class: 'field' }, h('label', { for: 'cur' }, forced ? 'Temporary password' : 'Current password'), cur),
    h('div', { class: 'field' }, h('label', { for: 'new' }, 'New password'), nw, h('div', { class: 'muted' }, 'At least 12 characters. A passphrase works well.')),
    h('div', { class: 'field' }, h('label', { for: 'new2' }, 'Repeat new password'), nw2),
    h('div', { class: 'row' }, btn, forced ? h('button', { type: 'button', onclick: logout }, 'Sign out') : null), err);
}

function changePasswordView() {
  app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'panel card' },
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Choose your password'),
    h('p', { class: 'muted' }, `Signed in as ${me.username}. Replace the temporary password before continuing.`),
    passwordForm(() => { toast('Password changed.'); render(); }, true))));
}

// ── dashboard ─────────────────────────────────────────────────────────────
function usageBar(pct) {
  const cls = pct == null ? '' : pct >= 75 ? 'bad' : pct >= 50 ? 'warn' : '';
  return h('div', { class: `bar ${cls}` }, h('span', { style: `width:${Math.min(100, pct || 0)}%` }));
}

/** Open Calls on a given tab (Reads by entity / Tool gaps). */
function openCalls(tab) { callsStartTab = tab; if (location.hash === '#/calls') render(); else location.hash = '#/calls'; }
let callsStartTab = null;

/**
 * THIS MCP's traffic, last 24 h: reads Autotask answered live (what to cache or
 * mirror next) and raw_request calls no tool covers (what to build next).
 */
function trafficCards(t) {
  if (!t) return null;
  const r = t.reads, g = t.gaps;
  const link = (tab, label) => h('button', { class: 'small', style: 'margin-top:10px', onclick: () => openCalls(tab) }, label);
  return [
    h('section', { class: 'panel' }, h('h2', null, 'Reads Autotask answered live (24 h)'),
      h('div', { class: 'stat' }, fmt(r.live), h('small', null, r.localPct == null ? '' : ` · ${r.localPct}% answered locally`)),
      r.top.length ? h('dl', { class: 'kv' }, r.top.flatMap((e) => [
        h('dt', { title: e.topCaller ? `Mostly from ${e.topCaller}` : '' }, e.entity),
        h('dd', null, `${fmt(e.live)} `, e.candidate ? h('span', { class: 'badge warn' }, 'mirror it') : (e.localPct ?? 0) > 0 ? h('span', { class: 'badge' }, `${e.localPct}% local`) : h('span', { class: 'badge warn' }, e.cached ? 'cache misses' : 'not cached'))]))
        : h('p', { class: 'muted' }, 'No live reads recorded yet.'),
      link('entities', 'Reads by entity →')),
    h('section', { class: 'panel' }, h('h2', null, 'Tool gaps: raw_request (24 h)'),
      h('div', { class: 'stat' }, fmt(g.uncoveredCalls), h('small', null, ` call(s) no tool covers · ${fmt(g.uncoveredShapes)} kind(s)`)),
      g.top.length ? h('dl', { class: 'kv' }, g.top.flatMap((x) => [
        h('dt', { class: 'mono', style: 'font-size:12px', title: x.caller ? `From ${x.caller}` : '' }, x.shape),
        h('dd', null, fmt(x.calls), x.errors ? [' ', h('span', { class: 'badge bad' }, `${fmt(x.errors)} failed`)] : null)]))
        : h('p', { class: 'muted' }, 'Every raw_request call has a tool that covers it.'),
      g.coveredCalls ? h('div', { class: 'muted', style: 'font-size:12.5px' }, `${fmt(g.coveredCalls)} more raw_request call(s) already have a tool — switch the caller.`) : null,
      link('gaps', 'Tool gaps →')),
  ];
}

async function dashboard(body) {
  const draw = async () => {
    const s = await api('GET', '/api/status');
    const at = s.api && s.api.autotask && !s.api.autotask.error ? s.api.autotask : null;
    const srv = s.api && s.api.server;
    const noApi = 'No Autotask API user is configured.';
    const banners = [];
    if (!s.tools.writesEnabled && !s.tools.planReadOnly) banners.push(h('div', { class: 'banner warn' }, 'Read-only mode: write tools are switched off for every agent.'));
    if (s.tools.disabledCategories.length) banners.push(h('div', { class: 'banner warn' }, `Disabled tool groups: ${s.tools.disabledCategories.join(', ')}.`));
    if (s.autotaskAuth) {
      const a = s.autotaskAuth;
      const retry = me.role === 'admin' ? h('button', { class: 'small', style: 'margin-left:10px', onclick: async (e) => {
        e.target.disabled = true;
        try { toast((await api('POST', '/api/actions/auth-retry', {})).message); await draw(); } catch (x) { toast(x.message); e.target.disabled = false; }
      } }, 'Retry now') : null;
      banners.push(a.held
        ? h('div', { class: 'banner bad' }, h('strong', null, 'Autotask calls are HELD: Autotask rejected the API login. '),
            `${a.failures} rejected logins since ${new Date(a.since).toLocaleString()}. The MCP sends no more test logins on its own, so the account can't be locked further. Fix the API user in Autotask (unlock it, or update the secret in the env file — a changed secret clears this by itself), then press Retry now.`, retry,
            h('div', { class: 'mono', style: 'margin-top:6px;font-size:12px' }, a.lastError))
        : a.blockedUntil
        ? h('div', { class: 'banner bad' }, h('strong', null, 'Autotask rejected the API credentials. '),
            `Autotask calls are paused until ${new Date(a.blockedUntil).toLocaleTimeString()} (failure ${a.failures} since ${new Date(a.since).toLocaleTimeString()}) so repeated failed logins don't lock the API user. Fix the user in Autotask (unlock it, or update the secret in the env file), then retry.`, retry,
            h('div', { class: 'mono', style: 'margin-top:6px;font-size:12px' }, a.lastError))
        : h('div', { class: 'banner warn' }, 'Autotask rejected the credentials earlier; the next Autotask call will test them again.', retry));
    }
    if (s.postgres.enabled && !s.postgres.ok) banners.push(h('div', { class: 'banner bad' }, `Postgres is unreachable: ${s.postgres.error || 'unknown error'}`));
    if (at && at.usedPct >= 75) banners.push(h('div', { class: 'banner bad' }, `Autotask API usage is at ${at.usedPct}% — Autotask is adding a 1 s delay to every call.`));
    else if (at && at.usedPct >= 50) banners.push(h('div', { class: 'banner warn' }, `Autotask API usage is at ${at.usedPct}% — Autotask is adding a 0.5 s delay to every call.`));

    const cards = h('div', { class: 'grid' },
      h('section', { class: 'panel' }, h('h2', null, 'Server'),
        h('div', { class: 'stat' }, s.version),
        h('dl', { class: 'kv' },
          h('dt', null, 'Up for'), h('dd', null, duration(s.uptimeSeconds)),
          h('dt', null, 'Started'), h('dd', null, when(s.startedAt)),
          h('dt', null, 'Node'), h('dd', null, s.node))),
      h('section', { class: 'panel' }, h('h2', null, 'Autotask API (whole tenant)'),
        at ? [h('div', { class: 'stat' }, `${at.usedPct ?? '—'}%`, h('small', null, ` of ${fmt(at.limit)} / h`)), usageBar(at.usedPct),
          h('div', { class: 'muted' }, `${fmt(at.used)} calls this hour · checked ${ago(s.api.autotaskCheckedAt)}`),
          s.outsideTraffic ? h('div', { class: 'muted', style: 'margin-top:6px;font-size:12.5px', title: 'The tenant total includes every integration with its own API user (Pax8, Datto RMM, IT Glue, …). Autotask’s API usage report says whose they are.' },
            `This MCP ${fmt(s.outsideTraffic.mcpCalls)} · other integrations ~${fmt(s.outsideTraffic.otherCalls)}${s.outsideTraffic.partial ? ' (MCP restarted < 1 h ago)' : ''}`) : null]
          : h('p', { class: 'muted' }, s.autotaskAuth ? 'Paused: Autotask rejected the credentials (see above).' : s.api && s.api.autotask && s.api.autotask.error ? `Unavailable: ${s.api.autotask.error}` : noApi)),
      h('section', { class: 'panel' }, h('h2', null, 'This MCP’s calls'),
        srv ? [h('div', { class: 'stat' }, fmt(srv.upstreamLastHour), h('small', null, ' last hour')),
          h('dl', { class: 'kv' },
            h('dt', null, 'Last 5 minutes'), h('dd', null, fmt(srv.upstreamLastFiveMinutes)),
            h('dt', null, 'Answered from cache'), h('dd', null, srv.savedPct == null ? '—' : `${srv.savedPct}%`),
            h('dt', null, 'Read cache'), h('dd', null, srv.cacheEnabled ? 'On' : 'Off'),
            h('dt', null, 'Rate-limited (429)'), h('dd', null, fmt(srv.rateLimited)))]
          : h('p', { class: 'muted' }, noApi)),
      trafficCards(s.mcpTraffic),
      h('section', { class: 'panel' }, h('h2', null, 'Tools'),
        h('div', { class: 'stat' }, fmt(s.tools.enabled), h('small', null, ` of ${fmt(s.tools.total)} enabled`)),
        h('dl', { class: 'kv' },
          h('dt', null, 'Write tools'), h('dd', null, s.tools.writesEnabled ? h('span', { class: 'badge ok' }, 'Allowed') : h('span', { class: 'badge warn' }, 'Off')),
          h('dt', null, 'Autotask credentials'), h('dd', null, s.secrets.autotaskCredentials ? h('span', { class: 'badge ok' }, 'Set') : h('span', { class: 'badge bad' }, 'Missing')),
          h('dt', null, 'Webhook secret'), h('dd', null, s.secrets.webhookSecret ? h('span', { class: 'badge ok' }, 'Set') : h('span', { class: 'badge' }, 'Not set')),
          h('dt', null, 'Postgres'), h('dd', null, !s.postgres.enabled ? 'Off' : s.postgres.ok ? h('span', { class: 'badge ok' }, `OK · ${s.postgres.latencyMs} ms`) : h('span', { class: 'badge bad' }, 'Down')))));

    const shadow = s.shadow.enabled
      ? h('section', { class: 'panel' },
          h('div', { class: 'row', style: 'justify-content:space-between' },
            h('h2', null, 'Postgres shadow'),
            h('div', { class: 'row' },
              h('span', { class: `badge ${s.shadow.syncEnabled ? 'ok' : 'warn'}` }, s.shadow.syncEnabled ? 'Sync on' : 'Sync paused'),
              h('span', { class: `badge ${s.shadow.serveReads ? 'ok' : ''}` }, s.shadow.serveReads ? 'Serving reads' : 'Not serving reads'),
              me.role === 'admin' ? h('button', { class: 'small', onclick: async (e) => {
                e.target.disabled = true;
                try { toast((await api('POST', '/api/actions/shadow-sync', {})).message); } catch (x) { toast(x.message); }
                setTimeout(() => { e.target.disabled = false; }, 5000);
              } }, 'Sync now') : null)),
          h('p', { class: 'muted' }, s.shadow.lastRun
            ? `Last run ${ago(s.shadow.lastRun.at)}: ${s.shadow.lastRun.skipped || `${s.shadow.lastRun.calls} Autotask call(s)`}. Max age ${s.shadow.maxAgeSeconds}s · pauses at ${s.shadow.pauseAtPct}% API usage · ${s.shadow.pendingRowRefreshes} row(s) queued for refresh.`
            : 'No sync run since this server started.'),
          h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Entity'), h('th', { class: 'num' }, 'Rows'), h('th', null, 'State'), h('th', null, 'Last sync'), h('th', null, 'History from'), h('th', { class: 'num' }, 'API calls (total)'), h('th', null, 'Last error'))),
            h('tbody', null, s.shadow.entities.map((e) => h('tr', null,
              h('td', null, e.entity), h('td', { class: 'num' }, fmt(e.rows)),
              h('td', null, e.ready ? (e.ageSeconds != null && e.ageSeconds > s.shadow.maxAgeSeconds ? h('span', { class: 'badge warn' }, 'Stale') : h('span', { class: 'badge ok' }, 'Ready')) : h('span', { class: 'badge warn' }, 'Backfilling')),
              h('td', null, ago(e.lastSyncedAt)), h('td', null, e.windowFrom || 'all'),
              h('td', { class: 'num' }, fmt(e.apiCallsTotal)),
              h('td', { class: e.lastError ? '' : 'muted' }, e.lastError ? `${e.lastError} (${ago(e.lastErrorAt)})` : '—')))))))
      : h('section', { class: 'panel' }, h('h2', null, 'Postgres shadow'), h('p', { class: 'muted' }, 'Not running on this server (MCP_PG_SHADOW_ENABLED is off).'));

    const v = s.shadow.enabled ? s.shadow.verify : null;
    const verifyBtn = me.role === 'admin' && s.shadow.enabled ? h('button', { class: 'small', onclick: async (e) => {
      e.target.disabled = true;
      try { toast((await api('POST', '/api/actions/shadow-verify', {})).message); } catch (x) { toast(x.message); }
      setTimeout(() => { e.target.disabled = false; draw().catch(() => undefined); }, 45_000);
    } }, 'Check now') : null;
    const issues = v && v.entities ? v.entities.filter((x) => x.differs || x.missing || x.countOk === false || x.error) : [];
    const verifyPanel = s.shadow.enabled ? h('section', { class: 'panel' },
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('h2', null, 'Mirror check (does Postgres match Autotask?)'),
        h('div', { class: 'row' },
          v ? h('span', { class: `badge ${v.status === 'ok' ? 'ok' : v.status === 'skipped' ? '' : 'warn'}` }, v.status === 'ok' ? 'Matches Autotask' : v.status === 'skipped' ? 'Skipped' : 'Needs attention') : h('span', { class: 'badge' }, 'Not run yet'),
          verifyBtn)),
      v ? h('p', { class: 'muted' }, v.skipped || `Last run ${ago(v.at)} (${v.trigger}): ${v.entities.reduce((n, x) => n + x.sampled, 0)} random rows across ${v.entities.length} entities re-read from Autotask and compared field by field, plus row counts; ${v.calls} Autotask calls. ${v.entities.reduce((n, x) => n + x.changed + x.pending, 0)} recently edited row(s) were simply waiting for the next sync. Differences are repaired from Autotask.`)
        : h('p', { class: 'muted' }, 'Runs nightly (about 2 Autotask calls per entity), or press Check now.'),
      issues.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Entity'), h('th', { class: 'num' }, 'Sampled'), h('th', { class: 'num' }, 'Differ'), h('th', { class: 'num' }, 'Missing'), h('th', null, 'Rows: mirror vs Autotask'), h('th', null, 'Examples'))),
        h('tbody', null, issues.map((x) => h('tr', null,
          h('td', null, h('strong', null, x.entity)), h('td', { class: 'num' }, fmt(x.sampled)),
          h('td', { class: 'num' }, x.differs ? h('span', { class: 'badge bad' }, fmt(x.differs)) : '0'),
          h('td', { class: 'num' }, x.missing ? h('span', { class: 'badge warn' }, fmt(x.missing)) : '0'),
          h('td', null, x.autotaskCount == null ? '—' : [`${fmt(x.mirrorCount)} vs ${fmt(x.autotaskCount)} `, x.countOk === false ? h('span', { class: 'badge warn' }, `Δ ${x.countDelta}`) : h('span', { class: 'badge ok' }, 'OK')]),
          h('td', { class: 'muted mono' }, x.error || x.examples.map((ex) => h('div', null, `#${ex.id} ${ex.status === 'missing' ? 'gone from Autotask' : ex.fields.join(', ')}`))))))))
        : null) : null;

    const top = srv && srv.topUpstream.length
      ? h('section', { class: 'panel' }, h('h2', null, 'Busiest Autotask calls since start'),
          h('p', { class: 'muted' }, `Since ${when(srv.since)} · ${fmt(srv.upstreamCalls)} upstream calls in total.`),
          h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Call'), h('th', { class: 'num' }, 'Count'))),
            h('tbody', null, srv.topUpstream.map((t) => h('tr', null, h('td', { class: 'mono' }, t.call), h('td', { class: 'num' }, fmt(t.count))))))))
      : null;

    const audit = s.audit
      ? h('section', { class: 'panel' }, h('h2', null, 'Audit ledger (last 24 h)'),
          Object.keys(s.audit.last24h).length
            ? h('dl', { class: 'kv' }, Object.entries(s.audit.last24h).map(([k, v]) => [h('dt', null, k), h('dd', null, fmt(v))]))
            : h('p', { class: 'muted' }, 'No events recorded in the last 24 hours.'))
      : null;

    body.replaceChildren(h('div', { class: 'row', style: 'justify-content:space-between' }, h('h1', null, 'Dashboard'), h('span', { class: 'muted' }, `Updated ${new Date().toLocaleTimeString()} · refreshes every 30 s`)),
      ...[...banners, cards, shadow, verifyPanel, top, audit].filter(Boolean));
  };
  await draw();
  refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') draw().catch(() => undefined); }, 30_000);
}

// ── calls (diagnostics) ───────────────────────────────────────────────────
const OUTCOME_LABEL = { ok: 'OK', error: 'Error', 'not-found': 'Not found', 'confirmation-required': 'Needs confirm', 'identification-required': 'Needs identity', 'idempotent-replay': 'Replayed', 'idempotency-refused': 'Key refused', 'permission-denied': 'Denied', running: 'Running' };
function outcomeBadge(o) {
  const cls = o === 'ok' || o === 'idempotent-replay' ? 'ok' : o === 'running' ? '' : o === 'error' || o === 'permission-denied' ? 'bad' : 'warn';
  return h('span', { class: `badge ${cls}` }, OUTCOME_LABEL[o] || o);
}
function statusBadge(s) {
  if (s == null) return h('span', { class: 'badge' }, '…');
  if (s === 0) return h('span', { class: 'badge bad' }, 'No answer');
  return h('span', { class: `badge ${s >= 500 || s === 429 ? 'bad' : s >= 400 ? 'warn' : 'ok'}` }, String(s));
}
const ms = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const timeOf = (iso) => new Date(iso).toLocaleTimeString();
function callerCell(r) {
  return h('div', null,
    h('span', { class: `badge ${r.named ? 'accent' : ''}`, title: r.named ? 'Named by a "Caller names" rule (Settings)' : null }, r.source || 'unknown'),
    r.user ? h('span', { class: 'muted' }, ` ${r.user}`) : null,
    r.ip || r.userAgent ? h('div', { class: 'muted mono' }, [r.ip, r.userAgent].filter(Boolean).join(' · ')) : null);
}

async function calls(body) {
  const state = { tab: callsStartTab || 'tools', errors: false, tool: '', source: '', auto: true, open: new Set(), hours: 24 };
  callsStartTab = null;
  const content = h('div');
  const errBox = h('input', { type: 'checkbox', onchange: (e) => { state.errors = e.target.checked; draw(); } });
  const toolBox = h('input', { type: 'text', placeholder: 'Filter by tool or path…', style: 'max-width:260px', oninput: (e) => { state.tool = e.target.value.trim(); clearTimeout(toolBox._t); toolBox._t = setTimeout(draw, 300); } });
  const sourceSel = h('select', { style: 'max-width:180px', onchange: (e) => { state.source = e.target.value; draw(); } }, h('option', { value: '' }, 'All callers'));
  const autoBox = h('input', { type: 'checkbox', checked: true, onchange: (e) => { state.auto = e.target.checked; } });
  const tabBtn = (id, label) => h('button', { class: `small ${state.tab === id ? 'primary' : ''}`, onclick: () => { state.tab = id; draw(); } }, label);

  const qs = () => {
    const p = new URLSearchParams({ limit: '150' });
    if (state.errors) p.set('errors', '1');
    if (state.tool) p.set('tool', state.tool);
    if (state.source && state.tab === 'tools') p.set('source', state.source);
    return p.toString();
  };

  async function apiCallsOf(id, cell) {
    cell.replaceChildren(h('span', { class: 'muted' }, 'Loading…'));
    const r = await api('GET', `/api/calls/api?toolCallId=${id}&limit=200`);
    cell.replaceChildren(r.calls.length
      ? h('table', null, h('tbody', null, r.calls.map((c) => h('tr', null,
          h('td', { class: 'muted' }, timeOf(c.at)), h('td', { class: 'mono' }, `${c.method} ${c.path}`), h('td', null, statusBadge(c.status)), h('td', { class: 'num' }, ms(c.durationMs)),
          h('td', { class: 'muted' }, c.error || '')))))
      : h('span', { class: 'muted' }, 'No Autotask calls: answered from the cache or the Postgres shadow, or the tool made none.'));
  }

  async function draw() {
    const [sum, list] = await Promise.all([
      api('GET', '/api/calls/summary?minutes=60'),
      state.tab === 'gaps' ? api('GET', `/api/calls/gaps?hours=${state.hours}`).then((r) => ({ ...r, calls: r.raw.filter((x) => !state.tool || x.shape.toLowerCase().includes(state.tool.toLowerCase())) }))
      : state.tab === 'entities' ? api('GET', `/api/calls/entities?hours=${state.hours}`).then((r) => ({ ...r, calls: r.entities.filter((e) => !state.tool || e.entity.toLowerCase().includes(state.tool.toLowerCase())) }))
      : state.tab === 'logs' ? api('GET', '/api/logs?limit=300').then((r) => ({ calls: r.logs.filter((l) => (!state.errors || l.level === 'error') && (!state.tool || (l.message + (l.meta || '')).toLowerCase().includes(state.tool.toLowerCase()))) }))
        : api('GET', `/api/calls/${state.tab === 'tools' ? 'tools' : 'api'}?${qs()}`),
    ]);
    const sources = [...new Set(sum.callers.map((c) => c.source))].sort();
    if (sourceSel.options.length - 1 !== sources.length) {
      sourceSel.replaceChildren(h('option', { value: '' }, 'All callers'), ...sources.map((s) => h('option', { value: s }, s)));
      sourceSel.value = state.source;
    }

    const callers = h('section', { class: 'panel' },
      h('h2', null, 'Who is calling (last hour)'),
      sum.callers.length || sum.background.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Caller'), h('th', { class: 'num' }, 'Tool calls'), h('th', { class: 'num' }, 'Errors'), h('th', { class: 'num', title: 'Searches that found nothing — not failures' }, 'Not found'), h('th', { class: 'num' }, 'Autotask calls'), h('th', null, 'Last seen'))),
            h('tbody', null,
              sum.callers.map((c) => h('tr', null, h('td', null, callerCell(c)), h('td', { class: 'num' }, fmt(c.calls)),
                h('td', { class: 'num' }, c.errors ? h('span', { class: 'badge bad' }, fmt(c.errors)) : '0'), h('td', { class: 'num' }, c.notFound ? h('span', { class: 'badge warn' }, fmt(c.notFound)) : '0'), h('td', { class: 'num' }, fmt(c.apiCalls)),
                h('td', null, `${ago(c.lastAt)} · `, h('span', { class: 'mono' }, c.lastTool)))),
              sum.background.map((b) => h('tr', null, h('td', null, h('span', { class: 'badge accent' }, 'background'), ' ', b.job), h('td', { class: 'num muted' }, '—'),
                h('td', { class: 'num' }, b.errors ? h('span', { class: 'badge bad' }, fmt(b.errors)) : '0'), h('td', { class: 'num muted' }, '—'), h('td', { class: 'num' }, fmt(b.apiCalls)), h('td', null, ago(b.lastAt)))))))
        : h('p', { class: 'muted' }, 'No calls in the last hour.'));

    let table;
    if (state.tab === 'gaps') {
      const o = list.outside;
      table = h('div', null,
        h('h3', null, 'raw_request use (the escape hatch)'),
        list.calls.length ? h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Request'), h('th', { class: 'num' }, 'Calls'), h('th', { class: 'num' }, 'Failed'), h('th', null, 'Existing tool'), h('th', null, 'Who'), h('th', null, 'Last'))),
          h('tbody', null, list.calls.map((r) => h('tr', null,
            h('td', { class: 'mono' }, r.shape, r.lastError ? h('div', { class: 'error', style: 'margin:2px 0 0;font-size:12px' }, r.lastError) : null),
            h('td', { class: 'num' }, fmt(r.calls)), h('td', { class: 'num' }, r.errors ? h('span', { class: 'badge bad' }, fmt(r.errors)) : '0'),
            h('td', null, r.coveredBy ? [h('span', { class: 'badge ok' }, 'Covered'), ' ', h('span', { class: 'mono' }, r.coveredBy.replace(/^autotask_/, '')), h('div', { class: 'muted', style: 'font-size:12px' }, 'switch the caller to this tool')] : h('span', { class: 'badge warn' }, 'No tool covers this — build one')),
            h('td', { class: 'muted' }, r.callers.map((c) => h('div', { class: 'mono' }, `${c.caller} × ${fmt(c.count)}`))),
            h('td', { class: 'muted' }, ago(r.lastAt))))))
          : h('p', { class: 'muted' }, 'No raw_request calls in this period.'),
        h('h3', null, 'Fallbacks: a tool failed, then the same caller used raw_request'),
        list.fallbacks.length ? h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Tool that failed'), h('th', null, 'Then raw_request'), h('th', { class: 'num' }, 'Times'), h('th', null, 'Tool error'), h('th', null, 'Last'))),
          h('tbody', null, list.fallbacks.map((f) => h('tr', null,
            h('td', { class: 'mono' }, f.failedTool.replace(/^autotask_/, '')), h('td', { class: 'mono' }, f.thenRaw), h('td', { class: 'num' }, fmt(f.count)),
            h('td', { class: 'muted' }, f.lastError || '—'), h('td', { class: 'muted' }, ago(f.lastAt))))))
          : h('p', { class: 'muted' }, 'None in this period.'),
        o ? h('p', { class: 'muted', style: 'font-size:12.5px;margin-top:14px' }, `For reference, not part of this MCP: other integrations made ~${fmt(o.otherCalls)} of the tenant's ${fmt(o.tenantCalls)} Autotask calls this hour (24 h average ~${fmt(o.otherAvg24h)}). They use their own API users; Autotask's API usage report lists them.`) : null);
    } else if (state.tab === 'entities') {
      const keep = (e) => {
        const out = [];
        if (e.mirrored) out.push(h('span', { class: `badge ${e.servedFromShadow ? 'ok' : ''}` }, e.servedFromShadow ? 'Mirrored · serving' : 'Mirrored · not serving'));
        out.push(h('span', { class: 'badge' }, e.cacheTtlSeconds ? `Cache ${e.cacheTtlSeconds >= 120 ? `${Math.round(e.cacheTtlSeconds / 60)} min` : `${e.cacheTtlSeconds} s`}` : 'Not cached'));
        if (e.candidate) out.push(h('span', { class: 'badge warn' }, 'Candidate to mirror'));
        return h('div', { class: 'row', style: 'gap:4px' }, out);
      };
      table = h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Entity'), h('th', { class: 'num' }, 'Autotask reads'), h('th', { class: 'num' }, 'From cache'), h('th', { class: 'num' }, 'From shadow'), h('th', { class: 'num' }, 'Writes'), h('th', null, 'Answered locally'), h('th', null, 'Kept locally'), h('th', null, 'Who causes the Autotask reads'))),
        h('tbody', null, list.calls.map((e) => h('tr', null,
          h('td', null, h('strong', null, e.entity)),
          h('td', { class: 'num' }, fmt(e.upstream)), h('td', { class: 'num' }, fmt(e.cache)), h('td', { class: 'num' }, fmt(e.shadow)), h('td', { class: 'num muted' }, fmt(e.writes)),
          h('td', { style: 'min-width:110px' }, e.localPct == null ? '—' : [`${e.localPct}%`, h('div', { class: `bar ${e.localPct < 25 ? 'bad' : e.localPct < 60 ? 'warn' : ''}` }, h('span', { style: `width:${e.localPct}%` }))]),
          h('td', null, keep(e)),
          h('td', { class: 'muted' }, e.topCallers.map((c) => h('div', { class: 'mono' }, `${c.caller.replace(/^autotask_/, '')} × ${fmt(c.count)}`)))))));
    } else if (state.tab === 'logs') {
      table = h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Level'), h('th', null, 'Message'))),
        h('tbody', null, list.calls.map((l) => h('tr', null,
          h('td', { class: 'muted', style: 'white-space:nowrap' }, `${new Date(l.at).toLocaleDateString()} ${timeOf(l.at)}`),
          h('td', null, h('span', { class: `badge ${l.level === 'error' ? 'bad' : 'warn'}` }, l.level)),
          h('td', null, l.message, l.meta ? h('div', { class: 'mono muted', style: 'word-break:break-all' }, l.meta) : null)))));
    } else if (state.tab === 'tools') {
      const rows = [];
      for (const c of list.calls) {
        const detail = h('td', { colspan: '6' });
        const detailRow = h('tr', { hidden: !state.open.has(c.id) }, detail);
        if (state.open.has(c.id)) apiCallsOf(c.id, detail).catch((e) => detail.replaceChildren(e.message));
        rows.push(h('tr', { style: 'cursor:pointer', title: 'Show the Autotask calls this tool call made', onclick: () => {
          detailRow.hidden = !detailRow.hidden;
          if (detailRow.hidden) state.open.delete(c.id); else { state.open.add(c.id); apiCallsOf(c.id, detail).catch((e) => detail.replaceChildren(e.message)); }
        } },
          h('td', { class: 'muted' }, timeOf(c.at)),
          h('td', null, h('span', { class: 'mono' }, c.tool.replace(/^autotask_/, '')), c.error ? h('div', { class: 'error', style: 'margin:2px 0 0;font-size:12.5px' }, c.error) : null),
          h('td', null, callerCell(c)),
          h('td', null, outcomeBadge(c.outcome)),
          h('td', { class: 'num' }, ms(c.durationMs)),
          h('td', { class: 'num' }, `${c.apiCalls} API`, c.cacheHits ? h('div', { class: 'muted' }, `${c.cacheHits} cached`) : null, c.shadowReads ? h('div', { class: 'muted' }, `${c.shadowReads} shadow`) : null)));
        rows.push(detailRow);
      }
      table = h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Tool'), h('th', null, 'Caller'), h('th', null, 'Result'), h('th', { class: 'num' }, 'Took'), h('th', { class: 'num' }, 'Autotask'))),
        h('tbody', null, rows));
    } else {
      table = h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Request'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Took'), h('th', null, 'Caused by'))),
        h('tbody', null, list.calls.map((c) => h('tr', null,
          h('td', { class: 'muted' }, timeOf(c.at)),
          h('td', null, h('span', { class: 'mono' }, `${c.method} ${c.path}`), c.error ? h('div', { class: 'error', style: 'margin:2px 0 0;font-size:12.5px' }, c.error) : null),
          h('td', null, statusBadge(c.status)),
          h('td', { class: 'num' }, ms(c.durationMs)),
          h('td', null, c.tool ? h('span', { class: 'mono' }, c.tool.replace(/^autotask_/, '')) : h('span', { class: 'badge accent' }, c.job || 'background'))))));
    }

    content.replaceChildren(callers,
      h('section', { class: 'panel' },
        h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' },
          h('div', { class: 'row' }, tabBtn('tools', 'Tool calls'), tabBtn('api', 'Autotask API calls'), tabBtn('entities', 'Reads by entity'), tabBtn('gaps', 'Tool gaps'), tabBtn('logs', 'Server log'),
            state.tab === 'entities' || state.tab === 'gaps' ? h('select', { style: 'max-width:150px', 'aria-label': 'Period', onchange: (e) => { state.hours = Number(e.target.value); draw(); } }, [1, 6, 24, 168].map((n) => { const o = h('option', { value: String(n) }, n === 168 ? 'Last 7 days' : `Last ${n} h`); o.selected = n === state.hours; return o; })) : null),
          h('div', { class: 'row' }, toolBox, state.tab === 'tools' ? sourceSel : null,
            h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center;margin:0' }, errBox, 'Errors only'))),
        list.calls.length || state.tab === 'gaps' ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'muted' }, state.tab === 'logs' ? 'No warnings or errors since the server started.' : state.tab === 'entities' ? 'No Autotask reads recorded in this period yet.' : 'Nothing matches.'),
        h('p', { class: 'muted', style: 'margin:10px 0 0' }, state.tab === 'gaps'
          ? '"Covered": an existing tool does the same thing (matched by name), so point that caller at it to get the cache, the shadow and the safety checks. "No tool covers this": a tool to build. Fallbacks show which tool is missing something.'
          : state.tab === 'entities'
          ? `Where each read was answered: Autotask, the short-lived read cache, or the Postgres shadow. "Candidate to mirror": ${list.candidateRule}. Counts are kept for 7 days, across restarts.`
          : state.tab === 'logs'
          ? 'Warnings and errors the server logged since it started (last 500). Credential-like fields are redacted.'
          : state.tab === 'tools'
          ? 'Newest first; click a row to see the Autotask calls it made. Arguments are never recorded.'
          : 'Newest first. Calls answered from the read cache or the Postgres shadow never reach Autotask, so they are not listed here.')));
  }

  const dl = (label, q) => h('a', { class: 'button-link', href: `/api/export?${q}`, download: '' }, label);
  const exportPanel = h('section', { class: 'panel' },
    h('h2', null, 'Export for testing and issue tracking'),
    h('p', { class: 'muted' }, 'Downloads what is in memory right now. Never includes credentials, tool arguments or response bodies.'),
    h('div', { class: 'row' },
      dl('Diagnostics bundle (JSON)', 'kind=bundle'),
      dl('Tool calls (CSV)', 'kind=tools&format=csv'),
      dl('Autotask calls (CSV)', 'kind=api&format=csv'),
      dl('Reads by entity (CSV)', 'kind=entities&format=csv'),
      dl('Tool gaps (CSV)', 'kind=gaps&format=csv'),
      dl('Server log (CSV)', 'kind=logs&format=csv')),
    h('p', { class: 'muted', style: 'margin:8px 0 0' }, 'The bundle holds the dashboard status, settings, callers for the last 24 h, every logged tool and Autotask call, the server log' + (me.role === 'admin' ? ', and the console activity log.' : '.')));
  body.replaceChildren(
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h1', null, 'Calls'),
      h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center' }, autoBox, 'Refresh every 10 s')),
    h('p', { class: 'muted' }, 'Recent tool calls from n8n, ChatGPT and other clients, and every request this MCP sent to Autotask. Kept in memory: the last 500 tool calls and 2,000 Autotask calls since the server started.'),
    content, exportPanel);
  await draw();
  refreshTimer = setInterval(() => { if (state.auto && document.visibilityState === 'visible') draw().catch(() => undefined); }, 10_000);
}

// ── actors (MCP-001: who is a person, who is automation) ─────────────────────
const ACTOR_TYPE_LABEL = { human: 'Person', service_account: 'Service account', integration: 'Integration', system: 'System', unknown: 'Unknown' };
const SOURCE_LABEL = { registry: 'set in registry', 'system-resource': 'Autotask system account', 'mcp-api-user': 'this MCP (n8n / Nexus / ChatGPT writes)', 'license-api-user': 'API User license', 'name-suggests-automation': 'name looks like automation — confirm', 'licensed-user': 'licensed user', 'not-found': 'no resource record', 'no-actor': 'no actor' };
async function actors(body) {
  const isAdmin = me.role === 'admin';
  const state = { type: '', q: '', inactive: false };
  const content = h('div');
  const getSetting = async (key) => ((await api('GET', '/api/settings')).settings.find((s) => s.key === key) || {}).value || [];
  async function saveLines(key, mutate) {
    const lines = await getSetting(key);
    const next = mutate(lines.slice());
    await api('PUT', `/api/settings/${key}`, { value: next });
  }
  async function setType(id, type, label) {
    await saveLines('actors.registry', (lines) => {
      const rest = lines.filter((l) => l.split('=')[0].trim() !== String(id));
      if (type) rest.push(`${id}=${type}${label ? ':' + label : ''}`);
      return rest;
    });
  }
  async function setReference(id, on, label) {
    await saveLines('actors.reference', (lines) => {
      const rest = lines.filter((l) => l.split('=')[0].trim() !== String(id));
      if (on) rest.push(`${id}${label ? '=' + label : ''}`);
      return rest;
    });
  }
  async function draw() {
    const r = await api('GET', `/api/actors${state.inactive ? '?inactive=1' : ''}`);
    const list = r.actors.filter((a) => (!state.type || a.actorType === state.type) && (!state.q || `${a.displayName || ''} ${a.resourceId}`.toLowerCase().includes(state.q.toLowerCase())));
    const typeBadge = (t) => h('span', { class: `badge ${t === 'human' ? 'ok' : t === 'unknown' ? 'warn' : ''}` }, ACTOR_TYPE_LABEL[t] || t);
    content.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        ...Object.entries(r.counts).map(([k, v]) => h('span', { class: 'badge' }, `${ACTOR_TYPE_LABEL[k] || k}: ${v}`)),
        h('span', { class: 'badge accent' }, `★ reference: ${r.referenceCount}`)),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Resource'), h('th', { class: 'num' }, 'ID'), h('th', null, 'Type'), h('th', null, 'Why'), h('th', null, 'Reference'), isAdmin ? h('th', null, 'Set type') : null)),
        h('tbody', null, list.map((a) => {
          const sel = isAdmin ? h('select', { 'aria-label': `Type of ${a.displayName || a.resourceId}`, onchange: async (e) => {
            try { await setType(a.resourceId, e.target.value, a.displayName); toast('Saved.'); await draw(); } catch (x) { toast(x.message); }
          } }, h('option', { value: '' }, '(automatic)'), ...['human', 'service_account', 'integration', 'system', 'unknown'].map((t) => h('option', { value: t }, ACTOR_TYPE_LABEL[t]))) : null;
          if (sel) sel.value = a.classificationSource === 'registry' && !a.reference ? a.actorType : '';
          return h('tr', null,
            h('td', null, h('strong', null, a.displayName || '—'), a.isActive === false ? h('span', { class: 'muted' }, ' (inactive)') : null),
            h('td', { class: 'num mono' }, String(a.resourceId)),
            h('td', null, typeBadge(a.actorType)),
            h('td', { class: 'muted' }, SOURCE_LABEL[a.classificationSource] || a.classificationSource),
            h('td', null, isAdmin
              ? h('label', { class: 'switch', title: 'Reference technician' }, h('input', { type: 'checkbox', checked: a.reference, 'aria-label': 'Reference technician', disabled: a.actorType !== 'human' && !a.reference, onchange: async (e) => {
                  try { await setReference(a.resourceId, e.target.checked, a.displayName); toast('Saved.'); await draw(); } catch (x) { toast(x.message); e.target.checked = !e.target.checked; }
                } }), h('span'))
              : (a.reference ? '★' : '')),
            sel ? h('td', null, sel) : null);
        }))))
    );
  }
  const search = h('input', { type: 'text', placeholder: 'Search name or id…', style: 'max-width:240px', oninput: (e) => { state.q = e.target.value.trim(); clearTimeout(search._t); search._t = setTimeout(draw, 250); } });
  const typeSel = h('select', { style: 'max-width:180px', onchange: (e) => { state.type = e.target.value; draw(); } }, h('option', { value: '' }, 'All types'), ...['human', 'service_account', 'integration', 'system', 'unknown'].map((t) => h('option', { value: t }, ACTOR_TYPE_LABEL[t])));
  const inactive = h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center;margin:0' }, h('input', { type: 'checkbox', onchange: (e) => { state.inactive = e.target.checked; draw(); } }), 'Show inactive');
  body.replaceChildren(
    h('h1', null, 'Actors'),
    h('p', { class: 'muted' }, 'Who changed a ticket: a person, or automation. Ticket history and the activity feed use this, and anything learning from technicians (Hermes) must only learn from "Person" — never from automation, including this MCP\'s own n8n / Nexus changes. "Unknown" needs confirming. ★ Reference technicians are the trusted standard.'),
    h('section', { class: 'panel' }, h('div', { class: 'row', style: 'margin-bottom:10px' }, search, typeSel, inactive), content));
  await draw();
}

// ── plan: what's on the account, and the upgrade path (locked modules stay visible) ──
const PLAN_MODE = { 'self-hosted': ['Self-hosted', 'ok'], licensed: ['Active', 'ok'], trial: ['Free trial', 'warn'], grace: ['Renewal due', 'warn'], expired: ['Expired', 'bad'], invalid: ['Licence problem', 'bad'] };
/** The upgrade card for one locked module (also used where a locked page would be). */
function upgradeCard(m, plan, onDone) {
  const where = [m.offer?.includedIn?.length ? `Included in ${m.offer.includedIn.join(' / ')}` : null, m.offer?.addon ? `Add-on: ${m.offer.addon}` : null].filter(Boolean);
  const note = h('textarea', { rows: 2, placeholder: 'Anything we should know? (optional)' });
  const btn = h('button', { class: 'primary small', onclick: async () => {
    btn.disabled = true;
    try { const r = await api('POST', '/api/plan/request', { module: m.id, note: note.value.trim() }); toast(r.message); onDone?.(); } catch (x) { toast(x.message); btn.disabled = false; }
  } }, 'Request upgrade');
  return h('div', { class: 'panel', style: 'border-style:dashed' },
    h('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' }, h('h3', { style: 'margin:0' }, `🔒 ${m.name}`), h('span', { class: 'badge warn' }, 'Not on your plan')),
    h('p', null, m.description),
    where.length ? h('p', { class: 'muted', style: 'font-size:13px' }, where.join(' · ')) : null,
    note, h('div', { class: 'row', style: 'margin-top:8px;gap:8px' }, btn, plan.upgradeUrl ? h('a', { href: plan.upgradeUrl, target: '_blank', rel: 'noopener noreferrer' }, 'See plans ↗') : null));
}
const PLAN_CHOICES = ['Starter', 'Pro', 'Enterprise'];
function choosePlanPanel(p, onDone) {
  const note = h('textarea', { rows: 2, placeholder: 'Anything we should know? Team size, billing contact… (optional)' });
  const pick = h('select', { 'aria-label': 'Plan', style: 'width:auto;min-width:160px' }, PLAN_CHOICES.map((n) => h('option', { value: n, selected: n === (p.planName || 'Pro') ? true : null }, n)));
  const btn = h('button', { class: 'primary', onclick: async () => {
    btn.disabled = true;
    try { const r = await api('POST', '/api/plan/request', { plan: pick.value, note: note.value.trim() }); toast(r.message); onDone?.(); } catch (x) { toast(x.message); btn.disabled = false; }
  } }, 'Request this plan');
  return h('section', { class: 'panel', style: 'border-color:var(--accent)' },
    h('h2', { style: 'margin-top:0' }, p.trial ? 'Keep PSArelay after your trial' : 'Turn on changes'),
    h('p', null, p.trial ? 'Choose a plan and we\'ll set up billing. Your setup, users and settings carry over, and tools that change Autotask unlock within a minute.' : 'Your plan is read-only. Choose a plan with changes and we\'ll update your account.'),
    h('div', { class: 'row', style: 'gap:8px;align-items:center;flex-wrap:wrap' }, pick, btn, p.upgradeUrl ? h('a', { href: p.upgradeUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Compare plans ↗') : null),
    h('div', { style: 'margin-top:8px' }, note));
}
async function planView(body) {
  const p = await api('GET', '/api/plan');
  const [label, cls] = PLAN_MODE[p.trial && p.mode === 'licensed' ? 'trial' : p.mode] || [p.mode, ''];
  const on = p.modules.filter((m) => m.included), off = p.modules.filter((m) => !m.included);
  fill(body, 
    h('h1', null, 'Plan'),
    p.trial || p.readOnly ? choosePlanPanel(p, () => planView(body)) : null,
    h('section', { class: 'panel' },
      h('div', { class: 'row', style: 'justify-content:space-between;align-items:center' },
        h('div', null, h('h2', { style: 'margin:0' }, p.mode === 'self-hosted' ? 'Self-hosted' : (p.planName || 'Your plan')), p.customer ? h('div', { class: 'muted' }, p.customer) : null),
        h('span', { class: `badge ${cls}` }, label)),
      h('p', { class: p.mode === 'invalid' || p.mode === 'expired' ? 'error' : 'muted' }, p.detail),
      p.expiresAt && p.mode !== 'self-hosted' ? h('p', { class: 'muted', style: 'font-size:13px' }, `Renews / expires ${p.expiresAt.slice(0, 10)}.`) : null),
    h('section', { class: 'panel' }, h('h2', null, `Included (${on.length})`),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px' }, on.map((m) => h('div', { class: 'panel', style: 'flex:1 1 240px;margin:0' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('strong', null, m.name), h('span', { class: 'badge ok' }, '✓ Included')), h('p', { class: 'muted', style: 'font-size:13px;margin:6px 0 0' }, m.description))))),
    off.length ? h('section', null, h('h2', null, `Add to your plan (${off.length})`), h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px;align-items:stretch' }, off.map((m) => h('div', { style: 'flex:1 1 300px' }, upgradeCard(m, p, () => planView(body)))))) : null);
}

// ── setup: connection, API-user permissions per module, mirror progress, connecting AI clients ──
const SETUP_STATUS = { ready: ['Ready', 'ok'], blocked: ['Blocked', 'bad'], unknown: ['Not fully checked', 'warn'] };
async function setup(body) {
  const isAdmin = me.role === 'admin';
  const out = h('div', { class: 'muted' }, 'Loading…');
  const copy = (text) => h('button', { class: 'small secondary', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Copy failed — select and copy it.'); } } }, 'Copy');
  const draw = (r) => {
    if (!r) { fill(out, h('p', { class: 'muted' }, isAdmin ? 'No check run yet on this server — press Run check (about 30 Autotask calls).' : 'No check run yet — ask an administrator to run it.')); return; }
    const c = r.connection;
    fill(out, 
      h('section', { class: 'panel' }, h('h2', null, 'Connection'),
        c.ok ? h('div', null,
          h('p', null, h('span', { class: 'badge ok' }, 'Connected'), ' Signed in as ', h('strong', null, c.apiUser?.name || `resource #${c.apiUser?.id ?? '?'}`), c.apiUser?.id ? h('span', { class: 'muted' }, ` (#${c.apiUser.id})`) : null),
          h('p', { class: 'muted', style: 'font-size:13px' }, `Autotask API usage ${c.usage?.usedPct ?? '?'}% of ${fmt(c.usage?.limit)} / hour.`, r.stopped ? h('span', { class: 'error' }, ` Stopped early: ${r.stopped}`) : null))
          : h('div', { class: 'banner bad' }, `Not connected: ${c.detail}`),
        h('p', { class: 'muted', style: 'font-size:12px' }, `Checked ${ago(r.at)}.`)),
      h('section', { class: 'panel' }, h('h2', null, 'Modules'),
        h('p', { class: 'muted', style: 'font-size:13px' }, 'Read access is probed live. Write access can’t be probed without writing — the security level of the API user must also allow the writes listed.'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Module'), h('th', null, 'Status'), h('th', null, 'Problems'), h('th', null, 'Writes it needs'))),
          h('tbody', null, r.modules.map((m) => { const [label, cls] = SETUP_STATUS[m.status] || [m.status, '']; return h('tr', null,
            h('td', null, h('strong', null, m.name)),
            h('td', null, h('span', { class: `badge ${cls}` }, label)),
            h('td', { style: 'font-size:13px' }, !c.ok ? h('span', { class: 'muted' }, 'Not checked — connect to Autotask first') : m.denied.length || m.unchecked.length ? [
              ...m.denied.map((d) => h('div', { class: 'error' }, `No read access: ${d.entity}`)),
              ...m.unchecked.map((d) => h('div', { class: 'muted' }, `${d.entity}: ${d.detail || 'not checked'}`))] : h('span', { class: 'muted' }, '—')),
            h('td', { style: 'font-size:12px' }, m.writes.length ? m.writes.map((w) => h('div', null, h('strong', null, w.entity), `: ${w.ops.join(', ')}`, h('span', { class: 'muted' }, ` — ${w.why}`))) : h('span', { class: 'muted' }, 'read only'))); }))))),
      r.mirror ? h('section', { class: 'panel' }, h('h2', null, 'Mirror'),
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('strong', null, `${r.mirror.ready} of ${r.mirror.total} entities backfilled`), h('span', { class: 'muted' }, `${fmt(r.mirror.entities.reduce((t, e) => t + e.rows, 0))} rows`)),
        h('div', { class: 'bar' }, h('span', { style: `width:${r.mirror.total ? Math.round((r.mirror.ready / r.mirror.total) * 100) : 0}%` })),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px;margin-top:8px' }, r.mirror.entities.map((e) => h('span', { class: `badge ${e.ready ? 'ok' : 'warn'}`, title: `${fmt(e.rows)} rows` }, e.entity))))
        : h('section', { class: 'panel' }, h('h2', null, 'Mirror'), h('p', { class: 'muted' }, 'The Postgres mirror is off on this server — every read goes to Autotask.')),
      h('section', { class: 'panel' }, h('h2', null, 'Connect your AI'),
        h('div', { class: 'row', style: 'align-items:center;gap:8px' }, h('span', null, 'MCP endpoint:'), h('code', { class: 'mono' }, r.connect.mcpUrl), copy(r.connect.mcpUrl)),
        /<this-host>/.test(r.connect.mcpUrl) ? h('p', { class: 'muted', style: 'font-size:12px' }, 'Set MCP_PUBLIC_URL to the address clients use (e.g. your tunnel), and this page shows it.') : null,
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, r.connect.clients.map((x) => h('tr', null, h('th', null, x.client), h('td', { style: 'font-size:13px' }, x.how), h('td', null, copy(x.how)))))))));
  };
  const run = h('button', { class: 'primary', onclick: async () => {
    run.disabled = true; run.textContent = 'Checking…';
    try { const r = await api('POST', '/api/setup/run', {}); draw(r.report); toast('Check finished.'); } catch (x) { toast(x.message); }
    finally { run.disabled = false; run.textContent = 'Run check'; }
  } }, 'Run check');
  fill(body, 
    h('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, h('h1', null, 'Setup'), isAdmin ? run : null),
    h('p', { class: 'muted' }, 'Is this server connected to Autotask, and is its API user allowed to do what each module needs? Then how to connect ChatGPT, Claude and n8n.'),
    isAdmin ? credentialsPanel() : null,
    securityPanel(),
    out);
  try { const r = await api('GET', '/api/setup'); draw(r.report); } catch (x) { fill(out, h('div', { class: 'error' }, x.message)); }
}

// ── the Autotask API user: test (carefully) and save in the console ──
function credentialsPanel() {
  const box = h('section', { class: 'panel' }, h('h2', null, 'Autotask API user'), h('p', { class: 'muted' }, 'Loading…'));
  const draw = async () => {
    const r = await api('GET', '/api/autotask/credentials');
    const user = h('input', { type: 'email', autocomplete: 'off', placeholder: 'API user email', value: r.username || '' , style: 'flex:1 1 220px' });
    const secret = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Secret', style: 'flex:1 1 180px' });
    const code = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Integration code', style: 'flex:1 1 180px' });
    const url = h('input', { type: 'url', autocomplete: 'off', placeholder: 'API URL (optional — found from the username)', style: 'flex:1 1 320px' });
    const steps = h('div');
    const values = () => ({ username: user.value.trim(), secret: secret.value, integrationCode: code.value.trim(), apiUrl: url.value.trim() });
    let tested = null;
    const save = h('button', { class: 'primary', disabled: true, onclick: async () => {
      if (JSON.stringify(values()) !== tested) { toast('The values changed since the test — test again.'); save.disabled = true; return; }
      if (!confirm('Use these credentials for every Autotask call from now on?')) return;
      save.disabled = true;
      try { const x = await api('POST', '/api/autotask/credentials', values()); toast(x.message); secret.value = ''; code.value = ''; await draw(); } catch (x) { toast(x.message); save.disabled = false; }
    } }, 'Save and use');
    const test = h('button', { class: 'secondary', onclick: async () => {
      test.disabled = true; save.disabled = true; steps.replaceChildren(h('p', { class: 'muted' }, 'Testing — one login attempt…'));
      try {
        const x = await api('POST', '/api/autotask/credentials/test', values());
        steps.replaceChildren(h('ul', { style: 'margin:8px 0' }, x.steps.map((s) => h('li', null, h('span', { class: `badge ${s.ok ? 'ok' : 'bad'}` }, s.ok ? '✓' : '✗'), ' ', s.detail))));
        if (x.ok) { tested = JSON.stringify(values()); save.disabled = !r.key.ok || !r.pg; }
      } catch (x) { steps.replaceChildren(h('div', { class: 'banner warn' }, x.message)); }
      finally { test.disabled = false; }
    } }, 'Test');
    for (const i of [user, secret, code, url]) i.oninput = () => { if (tested && JSON.stringify(values()) !== tested) save.disabled = true; };
    const clear = r.stored ? h('button', { class: 'small secondary', onclick: async () => {
      if (!confirm('Remove the credentials saved in the console and go back to the AUTOTASK_* environment variables?')) return;
      try { const x = await api('POST', '/api/autotask/credentials/clear', {}); toast(x.message); await draw(); } catch (x) { toast(x.message); }
    } }, 'Use the environment variables instead') : null;
    fill(box, h('h2', null, 'Autotask API user'),
      h('p', null, r.username ? h('span', null, 'In use: ', h('strong', null, r.username), r.source === 'console' ? h('span', { class: 'muted' }, ` — saved in the console by ${r.stored?.updatedBy ?? '?'} ${ago(r.stored?.updatedAt)}${r.stored?.verifiedAs ? `, verified as ${r.stored.verifiedAs}` : ''}`) : h('span', { class: 'muted' }, ' — from the environment variables (env file)')) : h('span', { class: 'error' }, 'No Autotask API user is configured.'), ' ', clear),
      r.problem ? h('div', { class: 'banner bad' }, r.problem) : null,
      !r.key.ok ? h('div', { class: 'banner warn' }, `Saving here needs an encryption key: ${r.key.detail}`) : null,
      h('p', { class: 'muted', style: 'font-size:13px' }, 'Replace or rotate the API user here. A test tries the login exactly once — a rejected one counts toward Autotask locking the user, so at most 3 tests per 15 minutes. Saved secrets are encrypted; a different Autotask database is refused.'),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, user, secret, code),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px;margin-top:8px' }, url, test, save),
      steps);
  };
  draw().catch((x) => fill(box, h('h2', null, 'Autotask API user'), h('div', { class: 'error' }, x.message)));
  return box;
}

// ── connect: one card per AI client; they sign in with the console login (OAuth), so there is nothing to install ──
async function connect(body) {
  const r = await api('GET', '/api/connect');
  const copy = (text, label = 'Copy') => h('button', { class: 'small secondary', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Copy failed — select it instead.'); } } }, label);
  const code = (text) => h('div', { class: 'row', style: 'gap:8px;align-items:center;margin:6px 0' }, h('code', { class: 'mono', style: 'flex:1;word-break:break-all;padding:6px 8px;border-radius:6px;background:var(--bg-soft, rgba(127,127,127,.12))' }, text), copy(text));
  const card = (title, steps, extra) => h('section', { class: 'panel', style: 'flex:1 1 320px;margin:0' }, h('h2', { style: 'margin-top:0' }, title), h('ol', { style: 'padding-left:18px;margin:6px 0' }, steps.map((s) => h('li', { style: 'margin:6px 0' }, s))), extra || null);
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const url = r.mcpUrl;
  const conns = h('div');
  const drawConns = (list) => fill(conns,
    list.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Client', 'Connected', 'Last sign-in refresh', ''].map((x) => h('th', null, x)))),
      h('tbody', null, list.map((c) => h('tr', null, h('td', null, c.clientName), h('td', { class: 'muted' }, ago(c.since)), h('td', { class: 'muted' }, ago(c.lastUsedAt)),
        h('td', null, h('button', { class: 'small secondary', onclick: async () => {
          if (!confirm(`Disconnect "${c.clientName}"? It has to sign in again to use PSArelay.`)) return;
          try { const x = await api('POST', `/api/me/connections/${c.family}/revoke`, {}); toast(x.message); drawConns((await api('GET', '/api/connect')).connections); } catch (x) { toast(x.message); }
        } }, 'Disconnect'))))))) : h('p', { class: 'muted' }, 'No AI client is signed in as you yet.'));
  drawConns(r.connections);
  fill(body,
    h('h1', null, 'Connect your AI'),
    h('p', { class: 'muted' }, 'Add PSArelay to your AI client, then sign in with this console login. The client then works as ', h('strong', null, r.linked?.name || 'your Autotask user'), ' — Autotask applies your own permissions. Nothing to install or configure on the server.'),
    !r.signIn.ready ? h('div', { class: 'banner warn' }, `Sign-in for AI clients is not available yet: ${r.signIn.reasons.join('; ')}. An administrator sets it; until then use an access token (Account page).`) : null,
    !r.linked ? h('div', { class: 'banner warn' }, 'Your console login is not linked to an Autotask user yet — ask an administrator (Users page). Signing in from an AI client is refused until then.') : null,
    h('section', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, 'Your PSArelay address'), code(url)),
    h('div', { class: 'row', style: 'flex-wrap:wrap;gap:12px;align-items:stretch' },
      card('ChatGPT', [
        h('span', null, link('https://chatgpt.com/#settings/Connectors', 'ChatGPT → Settings → Connectors'), ' → ', h('strong', null, 'Create'), ' (custom connector).'),
        h('span', null, 'Name it ', h('strong', null, 'PSArelay'), ', paste the address above, Authentication: ', h('strong', null, 'OAuth'), '.'),
        'Press Create / Connect — a PSArelay sign-in opens. Sign in with this console login.',
        'Business / Enterprise: a workspace admin can add it once and share it with the people who should have it; each person still signs in as themselves.',
      ]),
      card('Claude', [
        h('span', null, link('https://claude.ai/settings/connectors', 'Claude → Settings → Connectors'), ' → ', h('strong', null, 'Add custom connector'), '.'),
        'Paste the address above → Add → Connect — sign in with this console login.',
        'Team / Enterprise: an owner adds it for the organisation; each person connects and signs in as themselves.',
      ]),
      card('Codex', [
        'In a terminal on your computer:',
        code(`codex mcp add psarelay --url ${url}`),
        code('codex mcp login psarelay'),
        'The login opens a browser — sign in with this console login.',
      ]),
      card('n8n and scripts', [
        'They can\'t sign in interactively: create a token for them on your Account page (Connect your AI) — or an administrator creates a service token on the Access page.',
        h('span', null, 'Send it as ', h('span', { class: 'mono' }, 'Authorization: Bearer <token>'), ' to the address above.'),
      ])),
    h('section', { class: 'panel', style: 'margin-top:12px' }, h('h2', { style: 'margin-top:0' }, 'Signed in as you'), conns));
}

// ── security posture (zero trust): what this server exposes and who it trusts ──
const POSTURE = { ok: ['OK', 'ok'], warn: ['Check', 'warn'], bad: ['Exposed', 'bad'], info: ['Note', ''] };
function securityPanel() {
  const box = h('section', { class: 'panel' }, h('h2', null, 'Security'), h('p', { class: 'muted' }, 'Loading…'));
  api('GET', '/api/security').then((r) => {
    box.replaceChildren(h('h2', null, 'Security'),
      h('p', { class: 'muted', style: 'font-size:13px' }, 'Zero trust: who can reach this server, and who a call runs as. Fix anything marked Exposed first.'),
      h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, r.checks.map((c) => {
        const [label, cls] = POSTURE[c.status] || [c.status, ''];
        return h('tr', null, h('th', null, c.label), h('td', null, h('span', { class: `badge ${cls}` }, label)),
          h('td', { style: 'font-size:13px' }, c.detail, c.fix ? h('div', { class: 'muted' }, `→ ${c.fix}`) : null));
      })))));
  }).catch((x) => box.replaceChildren(h('h2', null, 'Security'), h('div', { class: 'error' }, x.message)));
  return box;
}

// ── access: tokens for /mcp (shown once, stored hashed), revocable ──
async function access(body) {
  const list = h('div');
  const shown = h('div');
  const draw = async () => {
    const r = await api('GET', '/api/access-tokens');
    if (!r.available) { list.replaceChildren(h('p', { class: 'muted' }, 'Access tokens need the Postgres layer (MCP_PG_ENABLED) and migration 0018.')); return; }
    const active = r.tokens.filter((t) => !t.revokedAt && !(t.expiresAt && Date.parse(t.expiresAt) < Date.now()));
    list.replaceChildren(
      r.required ? h('div', { class: 'banner ok' }, 'Tokens are required: calls without a valid token get HTTP 401.')
        : h('div', { class: 'banner warn' }, `Tokens are optional right now: anyone who can reach the MCP port can use it. When every client has a token (${active.length} active), turn on Settings → Security → Require an access token.`),
      r.tokens.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Name', 'Runs as', 'Token', 'Created', 'Last used', 'Status', ''].map((x) => h('th', null, x)))),
        h('tbody', null, r.tokens.map((t) => {
          const expired = t.expiresAt && Date.parse(t.expiresAt) < Date.now();
          const status = t.revokedAt ? h('span', { class: 'badge' }, `Revoked ${ago(t.revokedAt)}`) : expired ? h('span', { class: 'badge warn' }, 'Expired') : h('span', { class: 'badge ok' }, t.expiresAt ? `Active · until ${t.expiresAt.slice(0, 10)}` : 'Active');
          const revoke = !t.revokedAt ? h('button', { class: 'small secondary', onclick: async () => {
            if (!confirm(`Revoke "${t.name}"?\n\nEvery call with this token is refused from now on.`)) return;
            try { const x = await api('POST', `/api/access-tokens/${t.id}/revoke`, {}); toast(x.message); draw(); } catch (x) { toast(x.message); }
          } }, 'Revoke') : null;
          return h('tr', null, h('td', null, t.name, t.ownerUsername ? h('div', { class: 'muted', style: 'font-size:12px' }, `self-service · ${t.ownerUsername}`) : null), h('td', { style: 'font-size:13px' }, t.resourceId ? `Autotask resource #${t.resourceId}` : t.delegate ? 'The person it names (delegate)' : 'API user (service)'),
            h('td', { class: 'mono' }, `${t.prefix}…`), h('td', { class: 'muted' }, `${ago(t.createdAt)} by ${t.createdBy}`), h('td', { class: 'muted' }, t.lastUsedAt ? ago(t.lastUsedAt) : 'never'), h('td', null, status), h('td', null, revoke));
        })))) : h('p', { class: 'muted' }, 'No tokens yet.'));
  };
  const name = h('input', { placeholder: 'Who or what uses it, e.g. n8n', maxlength: 80, style: 'flex:1 1 220px' });
  const kind = h('select', null, h('option', { value: 'service' }, 'Service — runs as the API user'), h('option', { value: 'person' }, 'One person — runs as an Autotask resource'), h('option', { value: 'delegate' }, 'Delegate — may name the person it acts for (e.g. n8n for Teams)'));
  const rid = h('input', { type: 'number', min: 1, placeholder: 'Autotask resource id', style: 'display:none' });
  kind.onchange = () => { rid.style.display = kind.value === 'person' ? '' : 'none'; };
  const days = h('input', { type: 'number', min: 1, max: 3650, placeholder: 'Expires in days (empty = never)' });
  const create = h('button', { class: 'primary', onclick: async () => {
    create.disabled = true;
    try {
      const r = await api('POST', '/api/access-tokens', { name: name.value.trim(), resourceId: kind.value === 'person' ? rid.value : null, delegate: kind.value === 'delegate', expiresInDays: days.value });
      name.value = ''; rid.value = ''; days.value = '';
      shown.replaceChildren(h('div', { class: 'panel', style: 'border-style:dashed' },
        h('h3', { style: 'margin-top:0' }, `Token for "${r.item.name}"`),
        h('p', null, h('strong', null, 'Copy it now — it is shown only once.'), ' Only a fingerprint is stored, so it can\'t be shown again; if it is lost, revoke it and create a new one.'),
        h('p', { class: 'mono', style: 'word-break:break-all' }, r.token),
        h('div', { class: 'row', style: 'gap:8px' },
          h('button', { class: 'primary small', onclick: async () => { try { await navigator.clipboard.writeText(r.token); toast('Copied.'); } catch { toast('Copy failed — select the text instead.'); } } }, 'Copy'),
          h('button', { class: 'small secondary', onclick: () => shown.replaceChildren() }, 'Done')),
        h('p', { class: 'muted', style: 'font-size:13px' }, 'The client sends it on every call as the header ', h('span', { class: 'mono' }, 'Authorization: Bearer <token>'), '. In n8n: the MCP Client / HTTP Request credential → Header Auth.')));
      draw();
    } catch (x) { toast(x.message); } finally { create.disabled = false; }
  } }, 'Create token');
  body.replaceChildren(
    h('h1', null, 'Access'),
    h('p', { class: 'muted' }, 'Access tokens for the MCP endpoint. One per client, so each can be revoked on its own, and the token — not what the client claims — decides who a call runs as.'),
    shown,
    h('section', { class: 'panel' }, h('h2', null, 'New token'),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, name, kind, rid, days, create)),
    h('section', { class: 'panel' }, h('h2', null, 'Tokens'), list));
  try { await draw(); } catch (x) { list.replaceChildren(h('div', { class: 'error' }, x.message)); }
}

// ── bulk jobs: staged mass changes, pushed by the worker at a set pace ────
const BULK_STATUS = { preparing: ['Preparing', 'accent'], ready: ['Ready to approve', 'warn'], approved: ['Approved', 'accent'], running: ['Running', 'ok'], paused: ['Paused', 'warn'], done: ['Done', 'ok'], cancelled: ['Cancelled', ''], failed: ['Failed', 'bad'] };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
async function bulk(body) {
  const isAdmin = me.role === 'admin';
  const open = new Map(); // job id → items tab shown
  let showArchived = false;
  const list = h('div');
  const act = async (j, action) => {
    const p = j.progress;
    const confirmText = {
      approve: `Approve "${j.title}"?\n\n${fmt(p.pending)} write(s) to Autotask (${Object.entries(j.counts).map(([e, c]) => `${e}: ${fmt(c.pending || 0)}`).join(', ')}), ${fmt(p.excluded)} excluded.\nHash ${j.hash}.\n\nNothing is written until you Start it.`,
      start: `Start "${j.title}"?\n\nIt writes to Autotask: the canary (${j.canary.size}) first, then it pauses for you to check.`,
      resume: `Resume "${j.title}"?\n\n${fmt(p.pending)} write(s) left, about ${j.etaDays} day(s) at the set pace.`,
      cancel: `Cancel "${j.title}"?\n\nRecords already written stay as they are; the rest are not touched.`,
    }[action];
    if (confirmText && !confirm(confirmText)) return;
    try { const r = await api('POST', `/api/bulk-jobs/${j.id}/${action}`, action === 'approve' ? { hash: j.hash } : {}); toast(r.message); await draw(); } catch (x) { toast(x.message); }
  };
  const itemsBox = (j, tab) => {
    const box = h('div', { class: 'muted' }, 'Loading…');
    api('GET', `/api/bulk-jobs/${j.id}/items?status=${tab}&limit=50`).then((r) => {
      box.replaceChildren(r.items.length ? h('table', null,
        h('thead', null, h('tr', null, h('th', { class: 'num' }, '#'), h('th', null, 'Record'), h('th', null, tab === 'excluded' ? 'Why' : tab === 'failed' ? 'Error' : 'When'), h('th', null, ''))),
        h('tbody', null, r.items.map((x) => h('tr', null,
          h('td', { class: 'num mono' }, String(x.seq)),
          h('td', null, `${x.entity === 'Companies' ? 'Company' : 'Contact'} #${x.recordId}`, x.before && (x.before.name || x.before.email) ? h('div', { style: 'font-size:13px' }, [x.before.name, x.before.email].filter(Boolean).join(' · ')) : null, x.parentId ? h('span', { class: 'muted' }, ` (company #${x.parentId})`) : null),
          h('td', { class: tab === 'failed' ? 'error' : 'muted', style: 'font-size:13px' }, tab === 'excluded' ? x.reason || '' : tab === 'failed' ? `${x.error || ''} (${x.attempts} tries)` : x.doneAt ? ago(x.doneAt) : ''),
          h('td', null, x.link ? h('a', { href: x.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open ↗') : null)))))
        : h('p', { class: 'muted' }, 'None.'));
    }).catch((x) => box.replaceChildren(h('div', { class: 'error' }, x.message)));
    return box;
  };
  const card = (j) => {
    const [label, cls] = BULK_STATUS[j.status] || [j.status, ''];
    const p = j.progress;
    const live = !['done', 'cancelled', 'failed'].includes(j.status); // finished jobs show no pace / schedule
    const btn = (action, text, kind) => h('button', { class: `small ${kind || ''}`, onclick: () => act(j, action) }, text);
    const buttons = isAdmin ? [
      j.status === 'ready' ? btn('approve', 'Approve…', '') : null,
      j.status === 'approved' ? btn('start', 'Start (canary first)…', '') : null,
      j.status === 'running' ? btn('pause', 'Pause', 'secondary') : null,
      j.status === 'paused' ? btn('resume', 'Resume…', '') : null,
      p.failed ? btn('retry_failed', `Retry ${fmt(p.failed)} failed`, 'secondary') : null,
      !['done', 'cancelled', 'failed'].includes(j.status) ? btn('cancel', 'Cancel…', 'secondary') : null,
      !live && !j.archived ? btn('archive', 'Archive', 'secondary') : null,
      j.archived ? btn('unarchive', 'Restore', 'secondary') : null,
    ].filter(Boolean) : [];
    const tab = open.get(j.id);
    const tabs = ['done', 'failed', 'excluded', 'pending'].map((t) => h('button', { class: `small ${tab === t ? '' : 'secondary'}`, onclick: () => { open.set(j.id, tab === t ? null : t); draw(); } },
      { done: 'Recently done', failed: `Failed (${fmt(p.failed)})`, excluded: `Excluded (${fmt(p.excluded)})`, pending: 'Next up' }[t]));
    const sched = j.schedule;
    return h('section', { class: 'panel' },
      h('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
        h('div', null, h('h2', { style: 'margin:0' }, j.title), h('div', { class: 'muted mono', style: 'font-size:12px' }, j.id)),
        h('div', { class: 'row', style: 'gap:6px' }, j.archived ? h('span', { class: 'badge' }, 'Archived') : null, h('span', { class: `badge ${cls}` }, label))),
      j.status === 'preparing' ? h('p', { class: 'muted' }, 'Reading the records and checking each for history (paced). This page updates by itself.') : null,
      j.pauseReason ? (live ? h('div', { class: `banner ${/canary/.test(j.pauseReason) ? '' : 'bad'}`, style: 'margin:8px 0' }, j.pauseReason) : h('p', { class: 'muted', style: 'margin:6px 0' }, j.pauseReason)) : null,
      // A throttling wait is not an error (the record stays queued); any error clears once a write goes through.
      j.lastError && j.status !== 'done' ? (/waiting out Autotask throttling/.test(j.lastError) ? h('div', { class: 'muted', style: 'font-size:13px' }, `Waiting: ${j.lastError}`) : h('div', { class: 'error', style: 'font-size:13px' }, `Last error: ${j.lastError}`)) : null,
      p.total ? h('div', { style: 'margin:10px 0' },
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('strong', null, `${p.pct}%`), h('span', { class: 'muted' }, `${fmt(p.done + p.skipped)} of ${fmt(p.total)} writes · ${fmt(p.pending)} left${p.failed ? ` · ${fmt(p.failed)} failed` : ''}${p.excluded ? ` · ${fmt(p.excluded)} excluded` : ''}`)),
        h('div', { class: 'bar' }, h('span', { style: `width:${Math.min(100, p.pct)}%` }))) : null,
      h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null,
        live && h('tr', null, h('th', null, 'Pace now'), h('td', null, j.rate.quietUntil != null ? `quiet hours — nothing written until ${String(j.rate.quietUntil % 24).padStart(2, '0')}:00 · ${fmt(j.rate.doneLastHour)} done in the last hour` : `${fmt(j.rate.now)}/hour ${j.rate.inBusinessHours ? '(business hours)' : '(off hours)'} · ${fmt(j.rate.doneLastHour)} done in the last hour`)),
        live && h('tr', null, h('th', null, 'Quiet hours'), h('td', null, j.quietHours && j.quietHours.length ? `${j.quietHours.map((w) => `${String(w.start).padStart(2, '0')}:00–${String(w.end).padStart(2, '0')}:00${w.days ? ` ${w.days.map((d) => DAY_NAMES[d]).join(' ')}` : ''}`).join(', ')} (${(sched || { tz: 'America/New_York' }).tz}) — no writes (another integration's busy window)` : h('span', { class: 'muted' }, 'none'))),
        live && h('tr', null, h('th', null, 'Schedule'), h('td', null, sched ? `${fmt(j.rate.businessHours)}/hour ${sched.days.map((d) => DAY_NAMES[d]).join(' ')} ${String(sched.start).padStart(2, '0')}:00–${String(sched.end).padStart(2, '0')}:00 (${sched.tz}); ${fmt(j.rate.offHours)}/hour otherwise` : `${fmt(j.rate.offHours)}/hour, all day`)),
        p.pending && ['running', 'paused', 'approved', 'ready'].includes(j.status) ? h('tr', null, h('th', null, 'Time left'), h('td', null, j.etaDays >= 1 ? `about ${j.etaDays} day(s) at this schedule` : `about ${Math.max(1, Math.round(j.etaDays * 24))} hour(s) at this schedule`)) : null,
        h('tr', null, h('th', null, 'Per entity'), h('td', null, Object.entries(j.counts).map(([e, c]) => h('div', null, h('strong', null, e), `: ${Object.entries(c).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}`)))),
        j.stats.emailSummary ? h('tr', null, h('th', null, 'Email addresses'), h('td', null,
          h('div', { style: 'font-size:13px;margin-bottom:6px' }, `${fmt(j.stats.emailSummary.addresses)} address(es): `, h('strong', null, `${fmt(j.stats.emailSummary.kept)} kept`), ` (${fmt(j.stats.emailSummary.withTickets)} with tickets, ${fmt(j.stats.emailSummary.listed)} listed to keep${j.stats.emailSummary.junk ? `, ${fmt(j.stats.emailSummary.junk)} listed as junk` : ''}) · ${fmt(j.stats.emailSummary.duplicatesOfReal)} duplicate(s) of a contact on a real company · ${fmt(j.stats.emailSummary.onlyOnPlaceholders)} only on placeholders`),
          h('div', { class: 'table-wrap', style: 'max-height:320px;overflow:auto' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Email'), h('th', { class: 'num' }, 'Copies'), h('th', null, 'Decision'), h('th', null, 'Why'))),
            h('tbody', null, (j.stats.emailReview || []).slice(0, 100).map((r) => h('tr', null, h('td', { class: 'mono', style: 'font-size:12px' }, r.email), h('td', { class: 'num' }, fmt(r.copies)), h('td', null, h('span', { class: `badge ${r.decision === 'excluded' ? 'ok' : r.realCompanies.length ? 'warn' : ''}` }, r.decision === 'excluded' ? 'Kept' : 'Inactivate')), h('td', { style: 'font-size:12px' }, r.why)))))),
          (j.stats.emailReview || []).length > 100 ? h('div', { class: 'muted', style: 'font-size:12px' }, `First 100 of ${fmt(j.stats.emailSummary.addresses)}: kept first, then duplicates, then the most-copied. ChatGPT can list the rest (autotask_bulk_inactivate action=status).`) : null,
          h('div', { class: 'muted', style: 'font-size:12px' }, 'Recognise an address as a real person? Prepare again with it under "Keep these email addresses".'))) : null,
        j.kind === 'inactivate_company_contacts' && j.stats.companyDomains ? h('tr', null, h('th', null, 'Kept as the company\'s own'), h('td', null, Object.keys(j.stats.companyDomains).length ? Object.entries(j.stats.companyDomains).map(([d, why]) => h('div', null, h('strong', null, d), h('span', { class: 'muted' }, ` — ${why}`))) : h('span', { class: 'muted' }, 'none (no web address, no contact with history)'))) : null,
        j.kind === 'inactivate_company_contacts' && j.stats.byDomain ? h('tr', null, h('th', null, 'By email domain'), h('td', null, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Domain'), h('th', { class: 'num' }, 'Inactivate'), h('th', { class: 'num' }, 'Kept'), h('th', { class: 'num' }, 'Excluded'), h('th', { class: 'num' }, 'Already inactive'))),
          h('tbody', null, Object.entries(j.stats.byDomain).slice(0, 25).map(([d, c]) => h('tr', null, h('td', null, d), h('td', { class: 'num' }, fmt(c.inactivate)), h('td', { class: 'num' }, fmt(c.kept)), h('td', { class: 'num' }, fmt(c.excluded)), h('td', { class: 'num' }, fmt(c.alreadyInactive)))))),
          j.stats.domains > 25 ? h('div', { class: 'muted', style: 'font-size:12px' }, `${j.stats.domains - 25} more domain(s)`) : null)) : null,
        h('tr', null, h('th', null, 'Canary'), h('td', null, `${j.canary.size} write(s) first${j.canary.done ? ' — done' : ''}`)),
        h('tr', null, h('th', null, 'Who'), h('td', { class: 'muted' }, `prepared by ${j.createdBy || '?'} ${ago(j.createdAt)}${j.approvedBy ? ` · approved by ${j.approvedBy} ${ago(j.approvedAt)}` : ''}${j.startedAt ? ` · started ${ago(j.startedAt)}` : ''}${j.finishedAt ? ` · finished ${ago(j.finishedAt)}` : ''}`)),
        j.hash && j.status === 'ready' ? h('tr', null, h('th', null, 'Hash'), h('td', { class: 'mono' }, j.hash, h('span', { class: 'muted' }, ' — approval binds exactly these records'))) : null))),
      buttons.length ? h('div', { class: 'row', style: 'margin-top:10px' }, ...buttons) : null,
      p.total || p.excluded ? h('div', { style: 'margin-top:12px' }, h('div', { class: 'row' }, ...tabs), tab ? h('div', { style: 'margin-top:8px' }, itemsBox(j, tab)) : null) : null);
  };
  async function draw() {
    const r = await api('GET', `/api/bulk-jobs${showArchived ? '?archived=1' : ''}`);
    if (r.locked) { const p = await api('GET', '/api/plan'); const m = p.modules.find((x) => x.id === r.locked.module); list.replaceChildren(upgradeCard(m, p, draw)); return; }
    if (!r.available) { list.replaceChildren(h('p', { class: 'muted' }, 'Needs Postgres (MCP_PG_ENABLED) and migration 0015.')); return; }
    const toggle = r.archivedCount ? h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center;margin:0 0 10px' }, h('input', { type: 'checkbox', checked: showArchived, onchange: (e) => { showArchived = e.target.checked; draw(); } }), `Show archived (${fmt(r.archivedCount)})`) : null;
    list.replaceChildren(...[toggle, ...(r.jobs.length ? r.jobs.map(card) : [h('p', { class: 'muted' }, showArchived ? 'No bulk jobs.' : 'No bulk jobs yet (or all archived).')])].filter(Boolean));
  }

  // New cleanup (admins): prepared in the background, approved here, then run by the worker.
  const v = (name) => form.querySelector(`[name="${name}"]`);
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const days = [...form.querySelectorAll('[name="day"]:checked')].map((x) => Number(x.value));
    const body = {
      companyName: v('companyName').value.trim(), createdByResourceId: v('createdBy').value.trim() || null, excludeEmails: v('keepEmails').value.split(/[\s,;]+/).filter((e) => e.includes('@')), junkEmails: v('junkEmails').value.split(/[\s,;]+/).filter((e) => e.includes('@')), createdFrom: v('from').value || null, createdTo: v('to').value || null,
      includeContacts: v('contacts').checked, ratePerHour: Number(v('rate').value), canary: Number(v('canary').value),
      businessHours: v('bizOn').checked ? { tz: v('tz').value.trim(), days, start: Number(v('start').value), end: Number(v('end').value), businessRate: Number(v('bizRate').value) } : false,
      quietHours: v('quiet').value.trim() || 'none',
    };
    try { const r = await api('POST', '/api/bulk-jobs', body); toast(`Preparing job ${r.id.slice(0, 8)}… — it shows below.`); await draw(); } catch (x) { toast(x.message); }
  } },
    h('div', { class: 'row' },
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Placeholder company name', h('input', { name: 'companyName', value: 'Gmail', required: true, style: 'max-width:180px' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Created by resource ID (optional)', h('input', { name: 'createdBy', inputmode: 'numeric', style: 'max-width:160px' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Created from', h('input', { name: 'from', type: 'date' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Created to', h('input', { name: 'to', type: 'date' }))),
    h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center' }, h('input', { name: 'contacts', type: 'checkbox', checked: true }), 'Also inactivate their contacts'),
    h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Keep these email addresses (optional — real people; their placeholder companies are left alone)', h('textarea', { name: 'keepEmails', rows: 2, placeholder: 'jane.doe@gmail.com, …' })),
    h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Treat these addresses as junk (optional — spam senders whose tickets should not protect them)', h('textarea', { name: 'junkEmails', rows: 2, placeholder: 'spam.sender@outlook.com, …' })),
    h('div', { class: 'row' },
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Off-hours rate (writes/hour)', h('input', { name: 'rate', type: 'number', value: '3000', min: '60', max: '6000', style: 'max-width:120px' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Canary (writes, then pause)', h('input', { name: 'canary', type: 'number', value: '50', min: '1', max: '1000', style: 'max-width:100px' }))),
    h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center' }, h('input', { name: 'bizOn', type: 'checkbox', checked: true }), 'Slower during business hours'),
    h('div', { class: 'row' },
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Business-hours rate', h('input', { name: 'bizRate', type: 'number', value: '1000', min: '60', max: '6000', style: 'max-width:110px' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px', title: 'Local hours with no writes at all — another integration\'s burst window. Empty = none.' }, 'Quiet hours (no writes)', h('input', { name: 'quiet', value: '0-4, 21-22', placeholder: '0-4, 21-22', style: 'max-width:140px' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'From hour', h('input', { name: 'start', type: 'number', value: '7', min: '0', max: '23', style: 'max-width:80px' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'To hour', h('input', { name: 'end', type: 'number', value: '19', min: '1', max: '24', style: 'max-width:80px' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Time zone', h('input', { name: 'tz', value: 'America/New_York', style: 'max-width:180px' })),
      h('div', null, h('div', { style: 'font-size:13px;margin-bottom:4px' }, 'Days'), h('div', { class: 'row' }, DAY_NAMES.map((d, i) => h('label', { style: 'font-weight:400;display:flex;gap:4px;align-items:center;margin:0' }, h('input', { type: 'checkbox', name: 'day', value: String(i), checked: i >= 1 && i <= 5 }), d))))),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { type: 'submit' }, 'Prepare (nothing is written)'), h('span', { class: 'muted' }, 'Only placeholder names (Gmail, Outlook, Unknown…). Records with history are excluded. You approve the exact list before anything runs.')));

  // Junk contacts on one real company (by the domain rule or a list of contact ids).
  const cv = (name) => cform.querySelector(`[name="${name}"]`);
  const ids = (s) => s.split(/[\s,;]+/).filter(Boolean);
  const cform = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const days = [...form.querySelectorAll('[name="day"]:checked')].map((x) => Number(x.value));
    const body = {
      companyId: cv('companyId').value.trim(), contactIds: ids(cv('contactIds').value).map(Number), keepDomains: ids(cv('keep').value), onlyDomains: ids(cv('only').value),
      createdFrom: cv('from').value || null, createdTo: cv('to').value || null, includeNoEmail: cv('noEmail').checked, ticketsOk: cv('ticketsOk').checked,
      ratePerHour: Number(v('rate').value), canary: Number(cv('canary').value),
      businessHours: v('bizOn').checked ? { tz: v('tz').value.trim(), days, start: Number(v('start').value), end: Number(v('end').value), businessRate: Number(v('bizRate').value) } : false,
      quietHours: v('quiet').value.trim() || 'none',
    };
    try { const r = await api('POST', '/api/bulk-jobs', body); toast(`Preparing job ${r.id.slice(0, 8)}… — it shows above.`); await draw(); } catch (x) { toast(x.message); }
  } },
    h('div', { class: 'row' },
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Company ID', h('input', { name: 'companyId', inputmode: 'numeric', required: true, style: 'max-width:140px' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Also the company\'s own domains (optional)', h('input', { name: 'keep', placeholder: 'example.com, example.net', style: 'max-width:260px' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Only these domains (optional)', h('input', { name: 'only', placeholder: 'gmail.com, hotmail.com', style: 'max-width:260px' }))),
    h('div', { class: 'row' },
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Created from', h('input', { name: 'from', type: 'date' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Created to', h('input', { name: 'to', type: 'date' })),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Canary', h('input', { name: 'canary', type: 'number', value: '25', min: '1', max: '1000', style: 'max-width:100px' }))),
    h('label', { style: 'display:flex;flex-direction:column;gap:4px;font-size:13px' }, 'Or exactly these contact IDs (optional — replaces the domain rule)', h('textarea', { name: 'contactIds', rows: 2, placeholder: '30012345, 30012346 …' })),
    h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center' }, h('input', { name: 'noEmail', type: 'checkbox' }), 'Include contacts with no email address'),
    h('label', { style: 'font-weight:500;display:flex;gap:6px;align-items:center' }, h('input', { name: 'ticketsOk', type: 'checkbox' }), 'Inactivate contacts that are on tickets too (spam senders; the tickets stay as they are)'),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { type: 'submit' }, 'Prepare (nothing is written)'), h('span', { class: 'muted' }, 'Rates and business hours from the form above. Contacts on the company\'s own domains are kept; the primary contact and contacts with projects, contracts, opportunities, quotes, CIs or to-dos are always excluded. Review "By email domain" before approving.')));

  // When does the team work? Stacked per resource; people / via this MCP / integrations apart.
  const KIND_LABEL = { person: 'Person', mcp: 'Via this MCP', integration: 'Integration', unknown: 'Unknown' };
  const PALETTE = {
    person: ['#4f8cff', '#2bb3a3', '#7c6cf0', '#3fa34d', '#1f6fd1', '#5ec8e5', '#9b8cff', '#68c08a', '#8aa4c8'],
    mcp: ['#f0a030', '#e07b20', '#f5c060', '#c86a10', '#f0b878', '#d89040', '#f8d090', '#b05810', '#e0a868'],
    integration: ['#d65c5c', '#b84a7a', '#e07a8a', '#a04040', '#c87aa0', '#e89090', '#903060', '#d0a0a0', '#a87070'],
    unknown: ['#8a8f98', '#a0a4ab', '#6f747c', '#b8bbc0', '#5a5e66', '#c8cace', '#7c8088', '#9498a0', '#686c74'],
  };
  const kindBadge = (k) => h('span', { class: `badge ${k === 'person' ? 'ok' : k === 'mcp' ? 'warn' : k === 'integration' ? 'bad' : ''}`, style: 'font-size:11px' }, KIND_LABEL[k] || k);
  const hh = (n) => String(n).padStart(2, '0');
  const activity = h('div', { class: 'muted' }, 'Loading…');
  const drillBox = h('div');
  const view = { show: 'person' }; // person | all | mcp | integration
  let profile = null;
  const drill = (hour) => {
    drillBox.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    api('GET', `/api/bulk-jobs/activity?hour=${hour}`).then((d) => {
      const tbl = (head, rows, numLast = true) => h('table', null, h('thead', null, h('tr', null, head.map((x, i) => h('th', numLast && i === head.length - 1 ? { class: 'num' } : null, x)))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', numLast && i === r.length - 1 ? { class: 'num' } : null, c))))));
      drillBox.replaceChildren(
        h('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px' }, h('strong', null, `${hh(d.hour)}:00–${hh(d.hour)}:59 (${d.tz}), last ${d.days} days`), h('button', { class: 'small secondary', onclick: () => drillBox.replaceChildren() }, 'Close')),
        h('div', { class: 'row', style: 'align-items:flex-start;gap:24px' },
          h('div', null, h('h3', null, 'What'), tbl(['Kind', 'Count'], d.byKind.map((x) => [x.kind, fmt(x.n)]))),
          h('div', null, h('h3', null, 'Day of week'), tbl(['Day', 'Count'], d.byDay.map((x) => [DAY_NAMES[x.dow], fmt(x.n)]))),
          h('div', null, h('h3', null, 'Who'), tbl(['Resource', 'Type', 'Count'], d.byWho.map((x) => [x.name, kindBadge(x.kind), fmt(x.n)])))),
        h('h3', null, 'Latest in this hour'),
        d.latest.length ? h('div', { class: 'table-wrap' }, tbl(['When', 'Ticket Number', 'Ticket Title', 'Company Name', 'Kind', 'Who', 'Type'],
          d.latest.map((x) => [x.at, x.ticketNumber || (x.ticketId ? `#${x.ticketId}` : ''), x.title || '', x.company || '', x.type, x.name, kindBadge(x.kind)]), false)) : h('p', { class: 'muted' }, 'Nothing in this hour.'));
    }).catch((x) => drillBox.replaceChildren(h('div', { class: 'error' }, x.message)));
  };
  const drawActivity = () => {
    const a = profile;
    if (a.source !== 'team activity' || !a.series) {
      // No mirror: this MCP's own traffic, one colour.
      const wd = a.weekdayAvgPerHour || []; const max = Math.max(1, ...wd.map((x) => x || 0));
      activity.replaceChildren(h('div', { style: 'display:flex;align-items:flex-end;gap:2px;height:70px' }, wd.map((x, i) => h('div', { title: `${hh(i)}:00 — ${x == null ? 'no data' : `${fmt(x)} calls/hour`}`, style: `flex:1;background:var(--muted, #888);opacity:0.85;height:${Math.max(2, Math.round(((x || 0) / max) * 70))}px` }))),
        h('p', { class: 'muted', style: 'font-size:13px' }, `Tool-call traffic through this MCP (no Postgres mirror for team activity).`));
      return;
    }
    const shown = a.series.filter((s) => view.show === 'all' || s.kind === view.show || (view.show === 'integration' && s.kind === 'unknown'));
    const colour = new Map(); const used = {};
    for (const s of a.series) { const p = PALETTE[s.kind] || PALETTE.unknown; colour.set(s.key, p[(used[s.kind] = (used[s.kind] ?? -1) + 1) % p.length]); }
    const totals = new Array(24).fill(0).map((_, i) => shown.reduce((t, s) => t + (s.weekday[i] || 0), 0));
    const max = Math.max(0.01, ...totals);
    const inWin = (i) => a.suggested && i >= a.suggested.start && i < a.suggested.end;
    const bars = h('div', { style: 'display:flex;align-items:flex-end;gap:2px;height:110px' }, totals.map((tot, i) => {
      const parts = shown.filter((s) => s.weekday[i] > 0).map((s) => h('div', { style: `background:${colour.get(s.key)};height:${(s.weekday[i] / tot) * 100}%` }));
      const tip = [`${hh(i)}:00 — ${fmt(Math.round(tot * 10) / 10)} records on an average weekday${view.show === 'person' ? `, ${a.peopleActivePerHour[i]} people active` : ''}`, ...shown.filter((s) => s.weekday[i] > 0).sort((x, y) => y.weekday[i] - x.weekday[i]).slice(0, 8).map((s) => `  ${s.label}: ${s.weekday[i]}`)].join('\n');
      return h('div', { onclick: () => drill(i), title: tip, style: `flex:1;cursor:pointer;display:flex;flex-direction:column-reverse;height:${Math.max(2, Math.round((tot / max) * 110))}px;outline:${inWin(i) ? '2px solid var(--accent, #4f8cff)' : 'none'};outline-offset:1px` }, parts);
    }));
    const tabs = ['person', 'mcp', 'integration', 'all'].map((k) => h('button', { class: `small ${view.show === k ? '' : 'secondary'}`, onclick: () => { view.show = k; drawActivity(); } }, { person: 'People', mcp: 'Via this MCP', integration: 'Integrations', all: 'Everything' }[k]));
    const legend = h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px;font-size:12px;margin-top:6px' }, shown.map((s) => h('span', { style: 'display:inline-flex;align-items:center;gap:4px' }, h('span', { style: `display:inline-block;width:10px;height:10px;border-radius:2px;background:${colour.get(s.key)}` }), `${s.label} (${fmt(s.total)})`)));
    activity.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:8px' }, ...tabs),
      bars,
      h('div', { class: 'row', style: 'justify-content:space-between;font-size:12px' }, h('span', null, '00:00'), h('span', null, '12:00'), h('span', null, '23:00')),
      legend,
      h('p', { style: 'font-size:13px' }, a.suggested ? `People work ${hh(a.suggested.start)}:00–${hh(a.suggested.end)}:00 on weekdays (${a.tz}), outlined — use that as the business hours (the slower rate).` : 'No clear working hours in the data yet.', ' ',
        h('span', { class: 'muted' }, `Time entries and ticket notes on an average weekday, last ${a.days} days, ${fmt(a.events)} records, from the mirror. "Via this MCP" = written through this MCP (n8n, Nexus, ChatGPT), even when Autotask credits a person. Only people set the business hours.`)));
  };
  api('GET', '/api/bulk-jobs/activity').then((a) => { profile = a; drawActivity(); }).catch((x) => activity.replaceChildren(h('div', { class: 'error' }, x.message)));

  body.replaceChildren(
    h('h1', null, 'Bulk jobs'),
    h('p', { class: 'muted' }, 'Mass changes (e.g. inactivating tens of thousands of "Gmail" placeholder companies and their contacts) are prepared from the mirror, approved here, and pushed to Autotask by the server at a set pace — slower in business hours, a canary first, pausing itself on trouble. The console\'s read-only switch stops them too.'),
    list,
    isAdmin ? h('section', { class: 'panel' }, h('h2', null, 'New placeholder cleanup'), form) : null,
    isAdmin ? h('section', { class: 'panel' }, h('h2', null, 'Junk contacts on one company'), cform) : null,
    h('section', { class: 'panel' }, h('h2', null, 'When does the team work?'), activity, h('p', { class: 'muted', style: 'font-size:12px' }, 'Click an hour to see what is in it.'), drillBox));
  await draw();
  refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') draw().catch(() => undefined); }, 10_000);
}

// ── requests: what the MCP can't do yet ───────────────────────────────────
const GAP_STATUS_LABEL = { open: 'Open', planned: 'Planned', built: 'Built', declined: 'Declined', duplicate: 'Duplicate' };
const GAP_SOURCE_LABEL = { agent: 'AI agent', console: 'Person', auto: 'Captured' };
async function requests(body) {
  const isAdmin = me.role === 'admin';
  const state = { status: 'open,planned', q: '' };
  const content = h('div');
  async function draw() {
    const qs = new URLSearchParams({ ...(state.status ? { status: state.status } : {}), ...(state.q ? { q: state.q } : {}) });
    const r = await api('GET', `/api/gaps?${qs}`);
    if (!r.available) { content.replaceChildren(h('p', { class: 'muted' }, 'Needs Postgres (MCP_PG_ENABLED) — requests are stored there.')); return; }
    const statusBadgeOf = (s) => h('span', { class: `badge ${s === 'open' ? 'warn' : s === 'built' ? 'ok' : s === 'planned' ? 'accent' : ''}` }, GAP_STATUS_LABEL[s] || s);
    const edit = (g) => {
      if (!isAdmin) return statusBadgeOf(g.status);
      const sel = h('select', { 'aria-label': `Status of request ${g.id}`, onchange: async (e) => {
        try {
          const resolution = ['built', 'declined', 'duplicate'].includes(e.target.value) ? prompt(e.target.value === 'built' ? 'Which tool / release covers it?' : 'Why? (shown to whoever reported it)', g.resolution || '') : undefined;
          await api('PATCH', `/api/gaps/${g.id}`, { status: e.target.value, ...(resolution != null ? { resolution } : {}) }); toast('Saved.'); await draw();
        } catch (x) { toast(x.message); }
      } }, ...r.statuses.map((s) => h('option', { value: s }, GAP_STATUS_LABEL[s] || s)));
      sel.value = g.status;
      const pri = h('select', { 'aria-label': `Priority of request ${g.id}`, onchange: async (e) => { try { await api('PATCH', `/api/gaps/${g.id}`, { priority: e.target.value }); toast('Saved.'); await draw(); } catch (x) { toast(x.message); } } },
        ...r.priorities.map((p) => h('option', { value: p }, p)));
      pri.value = g.priority;
      return h('div', { class: 'row' }, sel, pri);
    };
    content.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:10px' }, ...r.statuses.map((s) => h('span', { class: 'badge' }, `${GAP_STATUS_LABEL[s]}: ${r.counts[s] || 0}`))),
      r.gaps.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Request'), h('th', null, 'From'), h('th', { class: 'num' }, 'Times'), h('th', null, 'Last'), h('th', null, isAdmin ? 'Status / priority' : 'Status'))),
        h('tbody', null, r.gaps.map((g) => h('tr', null,
          h('td', null, h('strong', null, `#${g.id} ${g.title}`), g.priority === 'high' ? h('span', { class: 'badge bad', style: 'margin-left:6px' }, 'high') : null,
            g.detail ? h('div', { class: 'muted', style: 'font-size:13px;margin-top:2px;white-space:pre-wrap' }, g.detail) : null,
            g.toolTried ? h('div', { class: 'mono muted', style: 'font-size:12px' }, `tried: ${g.toolTried}`) : null,
            g.resolution ? h('div', { style: 'font-size:13px;margin-top:2px' }, `→ ${g.resolution}`) : null),
          h('td', null, h('span', { class: 'badge' }, GAP_SOURCE_LABEL[g.source] || g.source), g.reporter ? h('div', { class: 'muted mono', style: 'font-size:12px' }, g.reporter) : null),
          h('td', { class: 'num' }, fmt(g.occurrences)),
          h('td', { class: 'muted' }, ago(g.lastSeen)),
          h('td', null, edit(g))))))) : h('p', { class: 'muted' }, 'Nothing here.'),
      h('h3', { style: 'margin-top:22px' }, 'Seen by the server, not reported yet'),
      h('p', { class: 'muted' }, 'raw_request calls in the last 7 days that no tool covers — clients doing it the hard way. Add one as a request to build a tool for it.'),
      r.uncovered.length ? h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Request'), h('th', { class: 'num' }, 'Calls'), h('th', { class: 'num' }, 'Failed'), h('th', null, 'Who'), h('th', null, ''))),
        h('tbody', null, r.uncovered.map((u) => h('tr', null,
          h('td', { class: 'mono' }, u.shape), h('td', { class: 'num' }, fmt(u.calls)), h('td', { class: 'num' }, u.errors ? h('span', { class: 'badge bad' }, fmt(u.errors)) : '0'),
          h('td', { class: 'muted' }, u.callers.slice(0, 3).map((c) => h('div', { class: 'mono' }, `${c.caller} × ${fmt(c.count)}`))),
          h('td', null, h('button', { class: 'small', onclick: async () => {
            try { await api('POST', '/api/gaps', { title: `Build a tool for ${u.shape}`, detail: `Clients call raw_request ${u.shape} (${u.calls} call(s), ${u.errors} failed, last 7 days) and no tool covers it.`, toolTried: 'autotask_raw_request', dedupeKey: `raw:${u.shape}` }); toast('Added to requests.'); await draw(); } catch (x) { toast(x.message); }
          } }, 'Add as request'))))))
        : h('p', { class: 'muted' }, 'None — every raw_request shape seen has a tool.'));
  }
  const title = h('input', { type: 'text', placeholder: 'What is missing? e.g. "Delete a contract charge"', style: 'flex:1;min-width:240px' });
  const detail = h('textarea', { rows: 2, placeholder: 'What were you trying to do, and what happened? (optional)', style: 'width:100%;margin-top:6px' });
  const add = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { const x = await api('POST', '/api/gaps', { title: title.value, detail: detail.value || undefined }); toast(x.created ? `Added request #${x.id}.` : `Already requested (#${x.id}) — counted again.`); title.value = ''; detail.value = ''; await draw(); } catch (x) { toast(x.message); }
  } }, h('div', { class: 'row' }, title, h('button', { type: 'submit' }, 'Add request')), detail);
  const statusSel = h('select', { style: 'max-width:200px', onchange: (e) => { state.status = e.target.value; draw(); } },
    h('option', { value: 'open,planned' }, 'Open + planned'), h('option', { value: 'open' }, 'Open'), h('option', { value: 'planned' }, 'Planned'), h('option', { value: 'built' }, 'Built'), h('option', { value: 'declined,duplicate' }, 'Declined / duplicate'), h('option', { value: '' }, 'All'));
  const search = h('input', { type: 'text', placeholder: 'Search…', style: 'max-width:220px', oninput: (e) => { state.q = e.target.value.trim(); clearTimeout(search._t); search._t = setTimeout(draw, 250); } });
  body.replaceChildren(
    h('h1', null, 'Requests'),
    h('p', { class: 'muted' }, 'What the MCP can\'t do yet, so it can be built: reported by AI agents (autotask_report_gap — e.g. ChatGPT when no tool fits), added here by people, or captured by the server (a client called a tool that doesn\'t exist). The same request again counts another time instead of a new row.'),
    h('section', { class: 'panel' }, h('h2', null, 'Add a request'), add),
    h('section', { class: 'panel' }, h('div', { class: 'row', style: 'margin-bottom:10px' }, statusSel, search), content));
  await draw();
}

// ── settings ──────────────────────────────────────────────────────────────
async function settings(body) {
  const isAdmin = me.role === 'admin';
  const draw = (list) => {
    const groups = {};
    for (const s of list) (groups[s.group] = groups[s.group] || []).push(s);
    const save = async (key, payload) => {
      try { draw((await api('PUT', `/api/settings/${encodeURIComponent(key)}`, payload)).settings); toast('Saved.'); }
      catch (x) { toast(x.message); draw((await api('GET', '/api/settings')).settings); }
    };
    const control = (s) => {
      const off = !isAdmin || !s.available || !!s.lockedByPlan;
      if (s.type === 'boolean') {
        return h('label', { class: 'switch', title: s.value ? 'On' : 'Off' },
          h('input', { type: 'checkbox', checked: !!s.value, disabled: off, 'aria-label': s.label, onchange: (e) => {
            if (s.key === 'tools.writesEnabled' && !e.target.checked && !confirm('Switch every agent to read-only? Creates, updates and deletes will be refused until you switch this back on.')) { e.target.checked = true; return; }
            save(s.key, { value: e.target.checked });
          } }), h('span'));
      }
      if (s.type === 'lines') {
        const ta = h('textarea', { rows: '4', disabled: off, 'aria-label': s.label, placeholder: 'pattern=name, one per line' });
        ta.value = (s.value || []).join('\n');
        return [ta, isAdmin ? h('button', { class: 'small', disabled: off, onclick: () => save(s.key, { value: ta.value.split('\n') }) }, 'Save') : null];
      }
      if (s.type === 'integer') {
        const inp = h('input', { type: 'number', value: String(s.value), min: s.min, max: s.max, disabled: off, 'aria-label': s.label });
        return [inp, isAdmin ? h('button', { class: 'small', disabled: off, onclick: () => save(s.key, { value: Number(inp.value) }) }, 'Save') : null];
      }
      return null;
    };
    const checks = (s) => {
      if (s.type !== 'string[]') return null;
      const boxes = (s.choices || []).map((c) => h('label', null, h('input', { type: 'checkbox', value: c, checked: s.value.includes(c), disabled: !isAdmin }), c.replace(/_/g, ' ')));
      return h('div', { class: 'checks' }, boxes, isAdmin ? h('div', null, h('button', { class: 'small', onclick: () => {
        const v = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        save(s.key, { value: v });
      } }, 'Save groups')) : null);
    };
    body.replaceChildren(
      h('h1', null, 'Settings'),
      isAdmin ? h('p', { class: 'muted' }, 'Changes apply immediately, with no restart, and are recorded in the activity log. The default for each setting comes from the server’s environment file.')
        : h('div', { class: 'banner' }, 'You have read-only access. An administrator can change these.'),
      ...Object.entries(groups).map(([g, items]) => h('section', { class: 'panel' }, h('h2', null, g), items.map((s) =>
        h('div', { class: 'setting' },
          h('div', null,
            h('div', null, h('strong', null, s.label), ' ', !s.available ? h('span', { class: 'badge' }, 'Not running') : s.overridden ? h('span', { class: 'badge accent' }, 'Changed') : null),
            h('div', { class: 'desc' }, s.description),
            s.lockedByPlan ? h('div', { class: 'desc', style: 'color:var(--warn)' }, s.lockedByPlan, ' ', h('a', { href: '#/plan' }, 'Choose a plan')) : null,
            h('div', { class: 'meta' }, `Default: ${Array.isArray(s.default) ? (s.default.join(', ') || 'none') : String(s.default)}`,
              s.overridden && isAdmin ? [' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); save(s.key, { reset: true }); } }, 'reset to default')] : null)),
          h('div', { class: 'control' }, control(s)),
          checks(s))))));
  };
  draw((await api('GET', '/api/settings')).settings);
}

// ── users ─────────────────────────────────────────────────────────────────
function showPassword(title, username, password) {
  const dlg = h('dialog', null,
    h('h2', null, title),
    h('p', null, `Give this temporary password to `, h('strong', null, username), '. It is shown only once; they will choose their own at first sign-in.'),
    h('div', { class: 'secret' }, password),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: async () => { try { await navigator.clipboard.writeText(password); toast('Copied.'); } catch { toast('Copy failed — select the text instead.'); } } }, 'Copy'),
      h('button', { onclick: () => { dlg.close(); dlg.remove(); } }, 'Done')));
  document.body.append(dlg);
  dlg.showModal();
}

// ── notifications (Discord / Teams / Slack / JSON webhooks) ─────────────────
const SEVERITY_BADGE = { critical: 'bad', warning: 'warn', info: 'ok' };
async function notifications(body) {
  const isAdmin = me.role === 'admin';
  const act = async (fn, ok) => { try { const r = await fn(); toast((r && r.message) || ok); await draw(); } catch (x) { toast(x.message); } };
  async function draw() {
    const r = await api('GET', '/api/notifications');
    const kindLabel = Object.fromEntries(r.kinds.map((k) => [k.kind, k.label]));
    const eventBoxes = (selected, onchange, idPrefix) => h('div', { class: 'checks' }, r.events.map((ev) => {
      const id = `${idPrefix}-${ev.type}`;
      return h('label', { for: id, style: 'display:flex;gap:8px;align-items:center;font-weight:400;margin:2px 0' },
        h('input', { type: 'checkbox', id, value: ev.type, checked: selected.includes(ev.type), disabled: !isAdmin, onchange }),
        h('span', { class: `badge ${SEVERITY_BADGE[ev.severity] || ''}` }, ev.severity), ev.label);
    }));
    const picked = (box) => [...box.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);

    // Add form (admins)
    let add = null;
    if (isAdmin) {
      const name = h('input', { type: 'text', id: 'nn', placeholder: 'e.g. #ops-alerts', maxlength: 60, required: true });
      const kind = h('select', { id: 'nk' }, r.kinds.map((k) => h('option', { value: k.kind }, k.label)));
      const help = h('p', { class: 'muted', style: 'margin:6px 0 0' });
      const url = h('input', { type: 'text', inputmode: 'url', id: 'nw', placeholder: 'https://…', autocomplete: 'off', spellcheck: 'false', required: true });
      const secret = h('input', { type: 'password', id: 'ns', placeholder: 'optional, 16+ characters', autocomplete: 'new-password' });
      const secretRow = h('div', { style: 'min-width:220px' }, h('label', { for: 'ns' }, 'Signing secret'), secret);
      const syncKind = () => { const k = r.kinds.find((x) => x.kind === kind.value); help.textContent = k ? `Where to get the URL: ${k.help}` : ''; secretRow.style.display = kind.value === 'generic' ? '' : 'none'; };
      kind.addEventListener('change', syncKind); syncKind();
      const evs = eventBoxes(['auth.held', 'auth.paused', 'backpressure.stop', 'operation.partial', 'shadow.verify_failed'], null, 'new');
      const err = h('p', { class: 'error', role: 'alert' });
      add = h('form', { class: 'panel', onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try {
          await api('POST', '/api/notifications', { name: name.value.trim(), kind: kind.value, url: url.value.trim(), events: picked(evs), ...(kind.value === 'generic' && secret.value ? { secret: secret.value } : {}) });
          toast('Channel added — use "Send test" to check it.'); await draw();
        } catch (x) { err.textContent = x.message; }
      } },
        h('h2', null, 'Add a channel'),
        h('div', { class: 'row', style: 'align-items:flex-end' },
          h('div', { style: 'flex:1;min-width:180px' }, h('label', { for: 'nn' }, 'Name'), name),
          h('div', { style: 'min-width:200px' }, h('label', { for: 'nk' }, 'Type'), kind)),
        h('div', { style: 'margin-top:8px' }, h('label', { for: 'nw' }, 'Webhook URL'), url, help),
        h('div', { class: 'row', style: 'margin-top:8px' }, secretRow),
        h('h3', null, 'Send these events'), evs,
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', type: 'submit' }, 'Add channel')),
        h('p', { class: 'muted', style: 'margin-top:8px' }, 'The URL is stored on the server and never shown again in full. Each event is sent at most once per 15 minutes per channel.'), err);
    }

    const list = r.channels.map((c) => {
      const evs = eventBoxes(c.events, isAdmin ? () => act(() => api('PUT', `/api/notifications/${c.id}`, { events: picked(evs) }), 'Saved.') : null, `c${c.id.slice(0, 8)}`);
      const st = c.status || {};
      return h('section', { class: 'panel' },
        h('div', { class: 'row', style: 'justify-content:space-between;align-items:center' },
          h('div', null, h('h2', { style: 'margin:0' }, c.name, ' ', h('span', { class: 'badge' }, kindLabel[c.kind] || c.kind), ' ', c.enabled ? h('span', { class: 'badge ok' }, 'On') : h('span', { class: 'badge' }, 'Off')),
            h('div', { class: 'muted mono', style: 'margin-top:4px' }, c.url, c.hasSecret ? ' · signed' : '')),
          isAdmin ? h('div', { class: 'row' },
            h('button', { class: 'small primary', onclick: () => act(() => api('POST', `/api/notifications/${c.id}/test`, {})) }, 'Send test'),
            h('button', { class: 'small', onclick: () => act(() => api('PUT', `/api/notifications/${c.id}`, { enabled: !c.enabled }), c.enabled ? 'Turned off.' : 'Turned on.') }, c.enabled ? 'Turn off' : 'Turn on'),
            h('button', { class: 'small', onclick: () => { const u = prompt(`New webhook URL for "${c.name}"`); if (u) act(() => api('PUT', `/api/notifications/${c.id}`, { url: u.trim() }), 'URL changed.'); } }, 'Change URL'),
            h('button', { class: 'small danger', onclick: () => confirm(`Delete the channel "${c.name}"?`) && act(() => api('DELETE', `/api/notifications/${c.id}`), 'Deleted.') }, 'Delete')) : null),
        h('p', { class: 'muted', style: 'margin:8px 0' },
          `Sent ${st.sent || 0}${st.lastSentAt ? ` · last ${ago(st.lastSentAt)} (${st.lastEvent})` : ''}`,
          st.lastError ? h('span', { class: 'error' }, ` · last failure ${ago(st.lastErrorAt)}: ${st.lastError}`) : null),
        evs);
    });
    // replaceChildren doesn't skip null or flatten arrays (h() does) — filter first.
    body.replaceChildren(...[
      h('h1', null, 'Notifications'),
      h('p', { class: 'muted' }, 'Post an alert to Discord, Microsoft Teams, Slack or any JSON webhook when something trips: the Autotask login is paused or held, Autotask says stop (usage ≥ 90%, 429), the mirror fails a sync or its consistency check, an n8n write fails half-way, or tools start failing. Checked every 20 seconds; a condition that persists is reported once.'),
      isAdmin ? null : h('div', { class: 'banner' }, 'Read-only: an administrator manages the channels.'),
      add,
      ...(list.length ? list : [h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'No channels yet.'))]),
    ].filter(Boolean));
  }
  await draw();
}

async function users(body) {
  const draw = async () => {
    const list = (await api('GET', '/api/users')).users;
    const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); await draw(); } catch (x) { toast(x.message); } };
    const name = h('input', { type: 'text', id: 'nu', placeholder: 'e.g. jsmith', autocomplete: 'off', required: true });
    const role = h('select', { id: 'nr' }, h('option', { value: 'viewer' }, 'Read-only (metrics)'), h('option', { value: 'admin' }, 'Administrator'));
    const err = h('p', { class: 'error', role: 'alert' });
    const add = h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { const r = await api('POST', '/api/users', { username: name.value.trim(), role: role.value }); showPassword('User created', r.user.username, r.password); await draw(); }
      catch (x) { err.textContent = x.message; }
    } },
      h('h2', null, 'Add a user'),
      h('div', { class: 'row', style: 'align-items:flex-end' },
        h('div', { style: 'flex:1;min-width:180px' }, h('label', { for: 'nu' }, 'Username'), name),
        h('div', { style: 'min-width:200px' }, h('label', { for: 'nr' }, 'Access'), role),
        h('button', { class: 'primary', type: 'submit' }, 'Create')),
      h('p', { class: 'muted', style: 'margin-top:8px' }, 'A temporary password is generated and shown once.'), err);

    const rows = list.map((u) => {
      const self = u.id === me.id;
      const roleSel = h('select', { 'aria-label': `Role of ${u.username}`, onchange: (e) => act(() => api('PATCH', `/api/users/${u.id}`, { role: e.target.value }), 'Role changed.') },
        h('option', { value: 'viewer' }, 'Read-only'), h('option', { value: 'admin' }, 'Administrator'));
      roleSel.value = u.role;
      return h('tr', null,
        h('td', null, h('strong', null, u.username), self ? h('span', { class: 'muted' }, ' (you)') : null),
        h('td', null, roleSel),
        h('td', null, u.disabled ? h('span', { class: 'badge bad' }, 'Disabled') : u.mustChangePassword ? h('span', { class: 'badge warn' }, 'Must set password') : h('span', { class: 'badge ok' }, 'Active')),
        h('td', { style: 'font-size:13px' }, u.autotaskResourceId ? h('span', null, u.autotaskResourceName || '', h('span', { class: 'muted' }, ` #${u.autotaskResourceId}`)) : h('span', { class: 'muted' }, 'Not linked'), ' ',
          h('button', { class: 'small secondary', onclick: () => {
            const v = prompt(`Link ${u.username} to their Autotask user.\n\nTheir Autotask email, or the resource id (a number). Leave empty to unlink.`, '');
            if (v === null) return;
            const t = v.trim();
            act(() => api('PUT', `/api/users/${u.id}/autotask`, !t ? { unlink: true } : /^\d+$/.test(t) ? { resourceId: Number(t) } : { email: t }), t ? 'Linked. Their own tokens now run as that Autotask user.' : 'Unlinked. Their own tokens stopped working.');
          } }, u.autotaskResourceId ? 'Change' : 'Link')),
        h('td', null, ago(u.lastLoginAt)),
        h('td', { class: 'muted' }, `${when(u.createdAt)}${u.createdBy ? ` by ${u.createdBy}` : ''}`),
        h('td', null, h('div', { class: 'row' },
          h('button', { class: 'small', onclick: () => confirm(`Reset the password of ${u.username}? They are signed out everywhere.`) && act(async () => { const r = await api('POST', `/api/users/${u.id}/reset-password`, {}); showPassword('Password reset', u.username, r.password); }) }, 'Reset password'),
          self ? null : h('button', { class: 'small', onclick: () => act(() => api('POST', `/api/users/${u.id}/sign-out`, {}), 'Signed out.') }, 'Sign out'),
          self ? null : h('button', { class: 'small', onclick: () => act(() => api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Enabled.' : 'Disabled.') }, u.disabled ? 'Enable' : 'Disable'),
          self ? null : h('button', { class: 'small danger', onclick: () => confirm(`Delete ${u.username}? This cannot be undone.`) && act(() => api('DELETE', `/api/users/${u.id}`), 'Deleted.') }, 'Delete'))));
    });
    body.replaceChildren(h('h1', null, 'Users'), add,
      h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'User'), h('th', null, 'Access'), h('th', null, 'Status'), h('th', null, 'Autotask user'), h('th', null, 'Last sign-in'), h('th', null, 'Created'), h('th', null, ''))),
        h('tbody', null, rows)))));
  };
  await draw();
}

// ── activity ──────────────────────────────────────────────────────────────
const ACTIONS = {
  'login': 'Signed in', 'login.failed': 'Failed sign-in', 'password.changed': 'Changed own password',
  'setting.changed': 'Changed setting', 'setting.reset': 'Reset setting', 'action.shadow_sync': 'Started shadow sync',
  'user.created': 'Created user', 'user.updated': 'Updated user', 'user.deleted': 'Deleted user',
  'user.password_reset': 'Reset password', 'user.signed_out': 'Signed user out', 'action.shadow_verify': 'Started mirror check',
  'notify.channel_added': 'Added notification channel', 'notify.channel_changed': 'Changed notification channel', 'notify.channel_removed': 'Deleted notification channel', 'notify.channel_tested': 'Sent test notification',
  'access.token_created': 'Created access token', 'access.token_revoked': 'Revoked access token', 'access.own_token_created': 'Created own access token', 'access.own_token_revoked': 'Revoked own access token',
  'autotask.credentials_tested': 'Tested Autotask credentials', 'autotask.credentials_saved': 'Saved Autotask credentials', 'autotask.credentials_cleared': 'Removed saved Autotask credentials',
  'oauth.approved': 'Connected an AI client (sign-in)', 'oauth.disconnected': 'Disconnected an AI client',
  'user.autotask_linked': 'Linked user to Autotask', 'user.autotask_unlinked': 'Unlinked user from Autotask',
};
function describe(ev) {
  const d = ev.details || {};
  if (ev.action.startsWith('setting.')) return `${d.key}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`;
  if (ev.action === 'login.failed') return d.reason || '';
  const parts = [];
  if (d.username) parts.push(d.username);
  if (d.role) parts.push(`role ${d.role}`);
  if (d.disabled !== undefined) parts.push(d.disabled ? 'disabled' : 'enabled');
  if (d.via) parts.push(`via ${d.via}`);
  if (ev.action.startsWith('notify.')) { if (d.name) parts.push(`${d.name}${d.kind ? ` (${d.kind})` : ''}`); if (d.ok === false) parts.push(`failed: ${d.error || ''}`); }
  return parts.join(' · ');
}
async function activity(body) {
  const events = [];
  const tbody = h('tbody');
  const more = h('button', { onclick: () => load() }, 'Load older');
  const load = async () => {
    const before = events.length ? events[events.length - 1].id : undefined;
    const r = await api('GET', `/api/events?limit=100${before ? `&before=${before}` : ''}`);
    events.push(...r.events);
    for (const ev of r.events) tbody.append(h('tr', null,
      h('td', null, when(ev.at)), h('td', null, ev.actor || '—'),
      h('td', null, ev.action === 'login.failed' ? h('span', { class: 'badge warn' }, ACTIONS[ev.action]) : (ACTIONS[ev.action] || ev.action)),
      h('td', null, describe(ev)), h('td', { class: 'mono muted' }, ev.ip || '')));
    more.hidden = r.events.length < 100;
  };
  body.replaceChildren(h('h1', null, 'Activity'), h('p', { class: 'muted' }, 'Sign-ins and every change made in this console or with the admin CLI.'),
    h('section', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'), h('th', null, 'Details'), h('th', null, 'IP'))), tbody)),
      h('div', { style: 'margin-top:10px' }, more)));
  await load();
}

// ── account ───────────────────────────────────────────────────────────────
async function account(body) {
  body.replaceChildren(h('h1', null, 'Account'),
    h('section', { class: 'panel', style: 'max-width:460px' },
      h('dl', { class: 'kv', style: 'margin-bottom:16px' },
        h('dt', null, 'Username'), h('dd', null, me.username),
        h('dt', null, 'Access'), h('dd', null, me.role === 'admin' ? 'Administrator' : 'Read-only'),
        h('dt', null, 'Password changed'), h('dd', null, when(me.passwordChangedAt))),
      h('h2', null, 'Change password'),
      passwordForm(() => { toast('Password changed. Other sessions were signed out.'); render(); }, false)),
    myConnections());
}

/** Account → Connect your AI: a user's own access tokens, always bound to the Autotask user an administrator linked. */
function myConnections() {
  const box = h('section', { class: 'panel' }, h('h2', null, 'Connect your AI'), h('p', { class: 'muted' }, 'Loading…'));
  const shown = h('div');
  const draw = async () => {
    const r = await api('GET', '/api/me/tokens');
    if (!r.available) { fill(box, h('h2', null, 'Connect your AI'), h('p', { class: 'muted' }, 'Needs the Postgres layer on this server.')); return; }
    if (!r.linked) { fill(box, h('h2', null, 'Connect your AI'), h('div', { class: 'banner warn' }, 'Your console user is not linked to an Autotask user yet. Ask an administrator to link it on the Users page — then you can connect your own AI client here, working with your own Autotask permissions.')); return; }
    const name = h('input', { placeholder: 'Which client, e.g. Codex on my laptop', maxlength: 80, style: 'flex:1 1 240px' });
    const days = h('select', null, h('option', { value: '30' }, '30 days'), h('option', { value: '90' }, '90 days'), h('option', { value: '180', selected: true }, '180 days'), h('option', { value: '365' }, '1 year'));
    const create = h('button', { class: 'primary', onclick: async () => {
      create.disabled = true;
      try {
        const x = await api('POST', '/api/me/tokens', { name: name.value.trim(), expiresInDays: days.value });
        const header = `Authorization: Bearer ${x.token}`;
        const copy = (text) => h('button', { class: 'small secondary', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Copy failed — select it instead.'); } } }, 'Copy');
        shown.replaceChildren(h('div', { class: 'panel', style: 'border-style:dashed' },
          h('p', null, h('strong', null, 'Copy it now — it is shown only once.'), ' If it is lost, revoke it and create another.'),
          h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null,
            h('tr', null, h('th', null, 'MCP address'), h('td', { class: 'mono' }, x.mcpUrl), h('td', null, copy(x.mcpUrl))),
            h('tr', null, h('th', null, 'Token'), h('td', { class: 'mono', style: 'word-break:break-all' }, x.token), h('td', null, copy(x.token))),
            h('tr', null, h('th', null, 'Header'), h('td', { class: 'mono', style: 'word-break:break-all' }, header), h('td', null, copy(header)))))),
          h('p', { class: 'muted', style: 'font-size:13px' }, 'Give your client the address and send the token as that header (n8n: Header Auth; Codex and other MCP clients: a bearer token). Calls run as ', h('strong', null, r.linked.name || `resource #${r.linked.id}`), ' — Autotask applies your own permissions to every change.'),
          h('button', { class: 'small secondary', onclick: () => shown.replaceChildren() }, 'Done')));
        await draw();
      } catch (x) { toast(x.message); } finally { create.disabled = false; }
    } }, 'Create my token');
    fill(box, h('h2', null, 'Connect your AI'),
      h('p', { class: 'muted', style: 'font-size:13px' }, 'Your own access to the MCP for a client you use (Codex, n8n, a script). It works as ', h('strong', null, r.linked.name || `resource #${r.linked.id}`), ' in Autotask, so you can only change what your Autotask account may change. ChatGPT and Claude connectors will sign in directly instead (coming).'),
      shown,
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, name, days, create),
      r.tokens.length ? h('div', { class: 'table-wrap', style: 'margin-top:12px' }, h('table', null,
        h('thead', null, h('tr', null, ['Client', 'Token', 'Created', 'Last used', 'Status', ''].map((x) => h('th', null, x)))),
        h('tbody', null, r.tokens.map((t) => {
          const expired = t.expiresAt && Date.parse(t.expiresAt) < Date.now();
          return h('tr', null, h('td', null, t.name), h('td', { class: 'mono' }, `${t.prefix}…`), h('td', { class: 'muted' }, ago(t.createdAt)), h('td', { class: 'muted' }, t.lastUsedAt ? ago(t.lastUsedAt) : 'never'),
            h('td', null, t.revokedAt ? h('span', { class: 'badge' }, 'Revoked') : expired ? h('span', { class: 'badge warn' }, 'Expired') : h('span', { class: 'badge ok' }, `Until ${t.expiresAt.slice(0, 10)}`)),
            h('td', null, !t.revokedAt && !expired ? h('button', { class: 'small secondary', onclick: async () => { if (!confirm(`Revoke "${t.name}"?`)) return; try { await api('POST', `/api/me/tokens/${t.id}/revoke`, {}); toast('Revoked.'); draw(); } catch (x) { toast(x.message); } } }, 'Revoke') : null));
        })))) : null);
  };
  draw().catch((x) => fill(box, h('h2', null, 'Connect your AI'), h('div', { class: 'error' }, x.message)));
  return box;
}

// ── boot ──────────────────────────────────────────────────────────────────
window.addEventListener('hashchange', render);
(async () => {
  try { me = (await api('GET', '/api/me')).user; } catch { me = null; }
  render();
})();
