/* Understory console — vanilla SPA, no build step.
   State lives in `state`; every render is a full replace of #app. */

const state = {
  user: null,
  overview: null,
  jobs: [],
  view: 'overview',
  authMode: 'login',
  error: '',
  filter: 'all',
  busy: false,
};

const $ = (sel) => document.querySelector(sel);
const app = () => $('#app');

/* ── api ─────────────────────────────────────────────────── */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Request failed (${res.status})`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ── utils ───────────────────────────────────────────────── */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const num = (n) => new Intl.NumberFormat('en-US').format(n ?? 0);

function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) {
    const f = Math.round(-s);
    return f < 90 ? `in ${f}s` : `in ${Math.round(f / 60)}m`;
  }
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ── data ────────────────────────────────────────────────── */

async function loadDashboard() {
  const [overview, jobs] = await Promise.all([
    api('/api/overview'),
    api('/api/jobs?limit=60'),
  ]);
  state.overview = overview;
  state.jobs = jobs.jobs;
}

async function boot() {
  try {
    const { user } = await api('/api/me');
    state.user = user;
    if (user) await loadDashboard();
  } catch {
    state.user = null;
  }
  render();
}

/* ── auth view ───────────────────────────────────────────── */

function renderAuth() {
  const isLogin = state.authMode === 'login';
  app().innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand" style="margin-bottom:22px">
          ${MARK}
          <span class="brand-word">Under<em>story</em></span>
        </div>
        <p class="eyebrow">// Client console</p>
        <h1 style="margin-top:10px">${isLogin ? 'Welcome <em>back.</em>' : 'Start <em>compounding.</em>'}</h1>
        <p class="muted" style="font-size:13.5px;margin:8px 0 0">
          ${isLogin ? 'Sign in to the growth ledger.' : 'Create an account to schedule your first cohort.'}
        </p>

        <div class="auth-tabs" role="tablist">
          <button role="tab" aria-selected="${isLogin}" data-auth-tab="login">Sign in</button>
          <button role="tab" aria-selected="${!isLogin}" data-auth-tab="register">Create account</button>
        </div>

        <form data-auth-form novalidate>
          <div class="field" style="margin-bottom:14px">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="email" placeholder="you@agency.com" required>
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" placeholder="••••••••••"
                   autocomplete="${isLogin ? 'current-password' : 'new-password'}" minlength="10" required>
            ${isLogin ? '' : '<small>At least 10 characters. Hashed with scrypt, never stored in clear.</small>'}
          </div>
          <p class="form-error" data-auth-error>${esc(state.error)}</p>
          <button class="btn btn-primary" type="submit" style="width:100%;margin-top:6px" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Working…' : (isLogin ? 'Sign in' : 'Create account')} <span aria-hidden="true">→</span>
          </button>
        </form>

        <p class="auth-note">
          Real accounts, real sessions, real database. Actions are executed by a mock
          provider — no social network is contacted.
        </p>
      </div>
    </div>`;
}

/* ── shell ───────────────────────────────────────────────── */

const MARK = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M12 28 L12 11 M12 19 Q20 17 22 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M12 24 Q17 23 19 17" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>
  <circle cx="22" cy="8" r="2.2" fill="#a3e635"/>
</svg>`;

function navButton(id, label, count) {
  return `<button data-nav="${id}" ${state.view === id ? 'aria-current="page"' : ''}>
    <span>${label}</span>${count ? `<span class="count">${count}</span>` : ''}
  </button>`;
}

function renderShell(inner) {
  const k = state.overview?.kpis;
  const title = {
    overview: ['Console / Overview', 'The growth <em>ledger.</em>'],
    brands: ['Console / Accounts', 'Brands under <em>management.</em>'],
    queue: ['Console / Engine', 'The <em>engine.</em>'],
  }[state.view];

  app().innerHTML = `
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="/">${MARK}<span class="brand-word">Under<em>story</em></span></a>
      <nav class="nav" aria-label="Console">
        ${navButton('overview', 'Overview')}
        ${navButton('brands', 'Accounts', k?.brands ?? 0)}
        ${navButton('queue', 'Queue', (k?.queued ?? 0) + (k?.running ?? 0))}
      </nav>
      <div class="sidebar-foot">
        <div class="user-chip">
          <span class="mono faint" style="font-size:9.5px">${esc(state.user.plan)} plan</span>
          <span class="email">${esc(state.user.email)}</span>
        </div>
        <button class="btn btn-ghost btn-sm" data-logout>Sign out</button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <p class="eyebrow">// ${title[0]}</p>
          <h1 style="margin-top:8px">${title[1]}</h1>
        </div>
        <div class="topbar-actions">
          <button class="btn btn-ghost btn-sm" data-refresh>Refresh</button>
          <button class="btn btn-primary btn-sm" data-nav="queue">Compose <span aria-hidden="true">→</span></button>
        </div>
      </header>
      ${inner}
    </main>
  </div>`;
}

/* ── overview ────────────────────────────────────────────── */

function chartSvg(series) {
  const W = 720, H = 200, pad = 26;
  const max = Math.max(1, ...series.map((d) => d.actions));
  const bw = (W - pad * 2) / series.length;
  const scale = (v) => (v / max) * (H - pad * 2);

  const bars = series.map((d, i) => {
    const x = pad + i * bw + bw * 0.17;
    const w = bw * 0.66;
    const ha = scale(d.actions);
    const hf = scale(d.follows);
    return `
      <rect class="bar-actions" x="${x.toFixed(1)}" y="${(H - pad - ha).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(ha, 1).toFixed(1)}" rx="1.5"><title>${d.day}: ${d.actions} actions</title></rect>
      <rect class="bar-follows" x="${x.toFixed(1)}" y="${(H - pad - hf).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(hf, 1).toFixed(1)}" rx="1.5"><title>${d.day}: ${d.follows} follow-backs</title></rect>`;
  }).join('');

  const ticks = series.map((d, i) => {
    if (i % 2 !== 0 && i !== series.length - 1) return '';
    const x = pad + i * bw + bw / 2;
    return `<text class="tick" x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${d.day.slice(5)}</text>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
     aria-label="Actions and follow-backs over the last 14 days">
    <line class="axis" x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}"/>
    ${bars}${ticks}
  </svg>`;
}

function jobsTable(jobs, { compact = false } = {}) {
  if (!jobs.length) {
    return `<div class="empty"><strong>Nothing queued.</strong>Compose an action and the worker will pick it up within seconds.</div>`;
  }
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Action</th><th>Brand</th><th>Target</th><th>Status</th><th>${compact ? 'When' : 'Run at'}</th>
      ${compact ? '' : '<th></th>'}
    </tr></thead>
    <tbody>
      ${jobs.map((j) => `<tr>
        <td>${esc(j.action)}</td>
        <td class="muted">${esc(j.brandName ?? '—')}</td>
        <td class="num">${esc(j.target)}</td>
        <td><span class="badge ${esc(j.status)}">${esc(j.status)}</span></td>
        <td class="num" title="${esc(j.runAt)}">${j.status === 'done' || j.status === 'failed' ? ago(j.finishedAt) : ago(j.runAt)}</td>
        ${compact ? '' : `<td class="row-actions">
          ${j.status === 'queued' ? `<button class="btn btn-danger btn-sm" data-cancel="${j.id}">Cancel</button>` : ''}
        </td>`}
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

function viewOverview() {
  const o = state.overview;
  const k = o.kpis;
  const recent = state.jobs.slice(0, 7);

  return `
  <section class="kpi-grid">
    <article class="kpi"><p class="kpi-label">Accounts</p>
      <p class="kpi-value">${num(k.brands)}${k.paused ? `<em>${k.paused} paused</em>` : ''}</p>
      <p class="kpi-note">${num(k.actions30d)} actions in 30 days</p></article>
    <article class="kpi"><p class="kpi-label">Actions today</p>
      <p class="kpi-value">${num(k.actionsToday)}</p>
      <p class="kpi-note">${num(k.reachToday)} reach · ${num(k.followsToday)} follow-backs</p></article>
    <article class="kpi"><p class="kpi-label">In flight</p>
      <p class="kpi-value">${num(k.queued + k.running)}</p>
      <p class="kpi-note">${num(k.done24h)} completed in 24h</p></article>
    <article class="kpi"><p class="kpi-label">Engagement</p>
      <p class="kpi-value">${k.engagementRate}<em>%</em></p>
      <p class="kpi-note">of delivered actions returned a signal</p></article>
  </section>

  <div class="grid-2">
    <section class="panel">
      <div class="panel-head">
        <h2>14-day ledger</h2>
        <span class="mono faint">actions / follow-backs</span>
      </div>
      <div class="panel-body">
        ${chartSvg(o.series)}
        <div class="chart-legend"><span><i class="swatch a"></i>Actions</span><span><i class="swatch f"></i>Follow-backs</span></div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Accounts</h2>
        <button class="btn btn-quiet btn-sm" data-nav="brands">Manage →</button></div>
      <div class="panel-body" style="padding:0">
        ${o.brands.length ? `<div class="table-wrap"><table><tbody>
          ${o.brands.map((b) => `<tr>
            <td><strong style="font-weight:400">${esc(b.name)}</strong><br><span class="brand-handle">@${esc(b.handle)} · ${esc(b.platform)}</span></td>
            <td class="num" style="text-align:right">${num(b.actionsToday)} today<br><span class="faint">${num(b.queued)} queued</span></td>
          </tr>`).join('')}
        </tbody></table></div>` : `<div class="empty"><strong>No accounts yet.</strong>Add a brand to start the engine.</div>`}
      </div>
    </section>
  </div>

  <section class="panel">
    <div class="panel-head">
      <h2>Recent activity</h2>
      <button class="btn btn-quiet btn-sm" data-nav="queue">Open queue →</button>
    </div>
    ${jobsTable(recent, { compact: true })}
  </section>`;
}

/* ── brands ──────────────────────────────────────────────── */

function viewBrands() {
  const brands = state.overview.brands;
  return `
  <div class="split" style="margin-bottom:18px">
    <p class="muted" style="margin:0;font-size:13.5px">
      Each account carries its own cadence governor. Paused accounts keep their history and hold their queue.
    </p>
    <button class="btn btn-primary btn-sm" data-toggle-brand-form>Add account <span aria-hidden="true">+</span></button>
  </div>

  <section class="panel" id="brand-form" hidden>
    <div class="panel-head"><h2>New account</h2></div>
    <div class="panel-body">
      <form data-brand-form>
        <div class="form-grid">
          <div class="field"><label for="b-name">Display name</label>
            <input id="b-name" name="name" placeholder="Fern &amp; Field" required></div>
          <div class="field"><label for="b-handle">Handle</label>
            <input id="b-handle" name="handle" placeholder="fernandfield" required></div>
          <div class="field"><label for="b-platform">Platform</label>
            <select id="b-platform" name="platform">
              <option value="instagram">Instagram</option>
              <option value="x">X</option>
              <option value="linkedin">LinkedIn</option>
              <option value="tiktok">TikTok</option>
              <option value="facebook">Facebook</option>
            </select></div>
          <div class="field"><label for="b-tz">Timezone</label>
            <input id="b-tz" name="timezone" placeholder="America/Los_Angeles" value="America/Los_Angeles"></div>
        </div>
        <p class="form-error" data-brand-error></p>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" type="submit">Create account</button>
          <button class="btn btn-ghost btn-sm" type="button" data-toggle-brand-form>Cancel</button>
        </div>
      </form>
    </div>
  </section>

  ${brands.length ? `<div class="brand-grid">
    ${brands.map((b) => `
      <article class="brand-card">
        <div class="brand-card-head">
          <div>
            <h3>${esc(b.name)}</h3>
            <span class="brand-handle">@${esc(b.handle)} · ${esc(b.platform)}</span>
          </div>
          <span class="badge ${esc(b.status)}">${esc(b.status)}</span>
        </div>
        <div class="brand-stats">
          <div><span class="n">${num(b.actionsToday)}</span><span class="mono faint" style="font-size:9px">today</span></div>
          <div><span class="n">${num(b.queued)}</span><span class="mono faint" style="font-size:9px">queued</span></div>
        </div>
        <div class="brand-actions">
          <button class="btn btn-quiet btn-sm" data-compose="${b.id}">Compose</button>
          <button class="btn btn-quiet btn-sm" data-toggle-pause="${b.id}" data-status="${b.status}">
            ${b.status === 'active' ? 'Pause' : 'Resume'}
          </button>
          <button class="btn btn-danger btn-sm" data-delete-brand="${b.id}" data-name="${esc(b.name)}">Remove</button>
        </div>
      </article>`).join('')}
  </div>` : `<div class="panel"><div class="empty"><strong>No accounts yet.</strong>Add one above — the queue will not run without an account.</div></div>`}`;
}

/* ── queue ───────────────────────────────────────────────── */

function viewQueue() {
  const brands = state.overview.brands;
  const filtered = state.filter === 'all'
    ? state.jobs
    : state.jobs.filter((j) => j.status === state.filter);

  const chip = (id, label) => `<button class="btn btn-sm ${state.filter === id ? 'btn-primary' : 'btn-ghost'}"
    data-filter="${id}">${label}</button>`;

  return `
  <section class="panel">
    <div class="panel-head">
      <h2>Compose</h2>
      <span class="mono faint">cadence-governed</span>
    </div>
    <div class="panel-body">
      ${brands.length ? `
      <form data-job-form>
        <div class="form-row">
          <div class="field"><label for="j-brand">Account</label>
            <select id="j-brand" name="brandId" required>
              ${brands.map((b) => `<option value="${b.id}">${esc(b.name)} — @${esc(b.handle)}</option>`).join('')}
            </select></div>
          <div class="field"><label for="j-action">Action</label>
            <select id="j-action" name="action">
              <option value="follow">Follow</option>
              <option value="like">Like</option>
              <option value="comment">Comment</option>
              <option value="view">View</option>
            </select></div>
          <div class="field"><label for="j-delay">Delay</label>
            <select id="j-delay" name="delaySeconds">
              <option value="0">Now</option>
              <option value="30">30 seconds</option>
              <option value="300">5 minutes</option>
              <option value="3600">1 hour</option>
            </select></div>
          <div class="field"><label for="j-target">Target</label>
            <input id="j-target" name="target" placeholder="@handle or profile URL" required></div>
          <div class="field"><label>&nbsp;</label>
            <button class="btn btn-primary btn-sm" type="submit">Queue action</button></div>
        </div>
        <p class="form-error" data-job-error></p>
        <small class="faint" style="font-size:11.5px">The mock provider records the target; nothing leaves this server. The worker picks it up within a few seconds.</small>
      </form>` : `<div class="empty"><strong>Add an account first.</strong>The engine schedules against a brand.</div>`}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Queue</h2>
      <div class="split" style="gap:6px">
        ${chip('all', 'All')}${chip('queued', 'Queued')}${chip('running', 'Running')}${chip('done', 'Done')}
      </div>
    </div>
    ${jobsTable(filtered)}
  </section>`;
}

/* ── render ──────────────────────────────────────────────── */

function render() {
  if (!state.user) return renderAuth();
  const view = state.view === 'brands' ? viewBrands() : state.view === 'queue' ? viewQueue() : viewOverview();
  renderShell(view);

  if (state.view === 'brands' && state.showBrandForm) {
    const panel = $('#brand-form');
    if (panel) panel.hidden = false;
  }
}

function refresh() {
  if (!state.user) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  loadDashboard().then(() => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    render();
  }).catch(() => {});
}

/* ── events ──────────────────────────────────────────────── */

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-nav]');
  if (!t) return;

  if (t.dataset.authTab) {
    state.authMode = t.dataset.authTab;
    state.error = '';
    return render();
  }

  if (t.dataset.nav) {
    state.view = t.dataset.nav;
    if (state.view === 'queue') state.showBrandForm = false;
    return render();
  }

  if (t.hasAttribute('data-refresh')) {
    await loadDashboard().catch(() => {});
    render();
    toast('Refreshed');
    return;
  }

  if (t.hasAttribute('data-logout')) {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null; state.overview = null; state.jobs = [];
    return render();
  }

  if (t.hasAttribute('data-toggle-brand-form')) {
    const panel = $('#brand-form');
    if (panel) {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.querySelector('input')?.focus();
    }
    return;
  }

  if (t.dataset.compose) {
    state.view = 'queue';
    render();
    const select = $('#j-brand');
    if (select) select.value = t.dataset.compose;
    $('#j-target')?.focus();
    return;
  }

  if (t.dataset.togglePause) {
    const next = t.dataset.status === 'active' ? 'paused' : 'active';
    try {
      await api(`/api/brands/${t.dataset.togglePause}`, { method: 'PATCH', body: { status: next } });
      await loadDashboard();
      render();
      toast(next === 'active' ? 'Account resumed' : 'Account paused');
    } catch (err) { toast(err.message, true); }
    return;
  }

  if (t.dataset.deleteBrand) {
    if (!confirm(`Remove ${t.dataset.name}? Its queue and ledger entries go with it.`)) return;
    try {
      await api(`/api/brands/${t.dataset.deleteBrand}`, { method: 'DELETE' });
      await loadDashboard();
      render();
      toast('Account removed');
    } catch (err) { toast(err.message, true); }
    return;
  }

  if (t.dataset.cancel) {
    try {
      await api(`/api/jobs/${t.dataset.cancel}/cancel`, { method: 'POST' });
      await loadDashboard();
      render();
      toast('Job cancelled');
    } catch (err) { toast(err.message, true); }
    return;
  }

  if (t.dataset.filter) {
    state.filter = t.dataset.filter;
    return render();
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;

  if (form.matches('[data-auth-form]')) {
    const data = Object.fromEntries(new FormData(form));
    state.busy = true; state.error = '';
    render();
    try {
      const path = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const { user } = await api(path, { method: 'POST', body: data });
      state.user = user;
      await loadDashboard();
      state.busy = false;
      render();
      toast(state.authMode === 'login' ? 'Signed in' : 'Account created');
    } catch (err) {
      state.busy = false;
      state.error = err.message;
      render();
    }
    return;
  }

  if (form.matches('[data-brand-form]')) {
    const data = Object.fromEntries(new FormData(form));
    const errEl = form.querySelector('[data-brand-error]');
    try {
      await api('/api/brands', { method: 'POST', body: data });
      await loadDashboard();
      state.showBrandForm = false;
      render();
      toast('Account created');
    } catch (err) {
      errEl.textContent = err.message;
    }
    return;
  }

  if (form.matches('[data-job-form]')) {
    const data = Object.fromEntries(new FormData(form));
    const errEl = form.querySelector('[data-job-error]');
    try {
      await api('/api/jobs', {
        method: 'POST',
        body: {
          brandId: Number(data.brandId),
          action: data.action,
          target: data.target,
          delaySeconds: Number(data.delaySeconds),
        },
      });
      form.reset();
      await loadDashboard();
      render();
      toast('Action queued');
    } catch (err) {
      errEl.textContent = err.message;
    }
  }
});

setInterval(refresh, 4000);
boot();
