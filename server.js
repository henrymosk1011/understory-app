/* Understory — API server + scheduler worker.
   Node 22+ only. Zero dependencies: node:http, node:sqlite, node:crypto.

   Run:  node server.js            (PORT=8787 by default)
         node server.js --seed     (adds a demo account with history)
*/

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { randomInt } from 'node:crypto';

import { q, nowIso, dayKey, shiftDay } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, userForToken,
  sessionCookie, clearCookie, readSessionCookie, isSecureRequest,
  throttleKey, tooManyAttempts, noteAttempt, clearAttempts,
} from './auth.js';

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = resolve('public');
const MAX_BODY = 64 * 1024;

const ACTIONS = {
  follow:  { label: 'Follow',  success: 0.94, engaged: 0.34, reach: 8 },
  like:    { label: 'Like',    success: 0.96, engaged: 0.17, reach: 3 },
  comment: { label: 'Comment', success: 0.90, engaged: 0.27, reach: 12 },
  view:    { label: 'View',    success: 0.99, engaged: 0.05, reach: 1 },
};
const PLATFORMS = ['instagram', 'x', 'linkedin', 'tiktok', 'facebook'];

/* ── http helpers ───────────────────────────────────────── */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "script-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const fail = (res, status, code, message, extra) =>
  send(res, status, { error: { code, message, ...extra } });

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const asText = (v) => (typeof v === 'string' ? v.trim() : '');
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

/* ── validation ─────────────────────────────────────────── */

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 10 && pw.length <= 200;
}

/* ── auth middleware ────────────────────────────────────── */

function requireUser(req, res) {
  const user = userForToken(readSessionCookie(req));
  if (!user) {
    fail(res, 401, 'unauthenticated', 'Sign in to continue.');
    return null;
  }
  return user;
}

/* ── route handlers ─────────────────────────────────────── */

async function handleRegister(req, res) {
  const body = await readJson(req);
  const email = asText(body.email).toLowerCase();
  if (!validEmail(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  if (!validPassword(body.password)) {
    throw new HttpError(400, 'weak_password', 'Use at least 10 characters.');
  }
  if (q.get('SELECT id FROM users WHERE email = ?', email)) {
    throw new HttpError(409, 'email_taken', 'That email is already registered.');
  }
  const info = q.run(
    'INSERT INTO users (email, password_hash, plan, created_at) VALUES (?, ?, ?, ?)',
    email, hashPassword(body.password), 'access', nowIso(),
  );
  const userId = Number(info.lastInsertRowid);
  const { token, expires } = createSession(userId);
  send(res, 201, { user: { id: userId, email, plan: 'access' } }, {
    'Set-Cookie': sessionCookie(token, expires, isSecureRequest(req)),
  });
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const email = asText(body.email).toLowerCase();
  const key = throttleKey(req, email);

  if (tooManyAttempts(key)) {
    throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in 15 minutes.');
  }

  const row = q.get('SELECT id, email, password_hash, plan FROM users WHERE email = ?', email);
  const ok = row && verifyPassword(body.password ?? '', row.password_hash);
  if (!ok) {
    noteAttempt(key);
    throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
  }

  clearAttempts(key);
  const { token, expires } = createSession(row.id);
  send(res, 200, { user: { id: row.id, email: row.email, plan: row.plan } }, {
    'Set-Cookie': sessionCookie(token, expires, isSecureRequest(req)),
  });
}

function handleLogout(req, res) {
  destroySession(readSessionCookie(req));
  send(res, 204, undefined, { 'Set-Cookie': clearCookie(isSecureRequest(req)) });
}

/* brands */

function brandRow(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    platform: row.platform,
    timezone: row.timezone,
    status: row.status,
    maxPerHour: row.max_per_hour,
    maxPerDay: row.max_per_day,
    createdAt: row.created_at,
    ...extra,
  };
}

function requireBrand(user, id) {
  const row = q.get('SELECT * FROM brands WHERE id = ? AND user_id = ?', Number(id), user.id);
  if (!row) throw new HttpError(404, 'brand_not_found', 'No such brand.');
  return row;
}

async function handleCreateBrand(req, res, user) {
  const body = await readJson(req);
  const name = asText(body.name);
  const handle = asText(body.handle).replace(/^@/, '');
  const platform = asText(body.platform).toLowerCase();
  const timezone = asText(body.timezone) || 'UTC';

  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'invalid_name', 'Name must be 2–80 characters.');
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(handle)) throw new HttpError(400, 'invalid_handle', 'Handle must be 2–40 letters, digits, dot, dash or underscore.');
  if (!PLATFORMS.includes(platform)) throw new HttpError(400, 'invalid_platform', 'Pick a supported platform.');

  try {
    const info = q.run(
      `INSERT INTO brands (user_id, name, handle, platform, timezone, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      user.id, name, handle, platform, timezone, nowIso(),
    );
    const row = q.get('SELECT * FROM brands WHERE id = ?', Number(info.lastInsertRowid));
    send(res, 201, { brand: brandRow(row) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new HttpError(409, 'brand_exists', 'That handle is already tracked on this platform.');
    }
    throw err;
  }
}

function handleListBrands(res, user) {
  const rows = q.all('SELECT * FROM brands WHERE user_id = ? ORDER BY created_at', user.id);
  const today = dayKey();
  const brands = rows.map((row) => {
    const todayRow = q.get('SELECT actions FROM ledger WHERE brand_id = ? AND day = ?', row.id, today);
    const queued = q.get('SELECT COUNT(*) AS n FROM jobs WHERE brand_id = ? AND status = ?', row.id, 'queued');
    return brandRow(row, { actionsToday: todayRow?.actions ?? 0, queued: queued.n });
  });
  send(res, 200, { brands });
}

async function handleUpdateBrand(req, res, user, id) {
  const row = requireBrand(user, id);
  const body = await readJson(req);

  const name = body.name === undefined ? row.name : asText(body.name);
  const handle = body.handle === undefined ? row.handle : asText(body.handle).replace(/^@/, '');
  const status = body.status === undefined ? row.status : asText(body.status);
  const maxPerHour = body.maxPerHour === undefined ? row.max_per_hour : clampInt(body.maxPerHour, 1, 60);
  const maxPerDay = body.maxPerDay === undefined ? row.max_per_day : clampInt(body.maxPerDay, 1, 500);

  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'invalid_name', 'Name must be 2–80 characters.');
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(handle)) throw new HttpError(400, 'invalid_handle', 'Invalid handle.');
  if (!['active', 'paused'].includes(status)) throw new HttpError(400, 'invalid_status', 'Status must be active or paused.');

  q.run(
    `UPDATE brands SET name = ?, handle = ?, status = ?, max_per_hour = ?, max_per_day = ?
      WHERE id = ? AND user_id = ?`,
    name, handle, status, maxPerHour, maxPerDay, row.id, user.id,
  );
  send(res, 200, { brand: brandRow(q.get('SELECT * FROM brands WHERE id = ?', row.id)) });
}

function handleDeleteBrand(res, user, id) {
  const row = requireBrand(user, id);
  q.run('DELETE FROM brands WHERE id = ? AND user_id = ?', row.id, user.id);
  send(res, 204, undefined);
}

/* jobs */

const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];

function jobRow(row) {
  return {
    id: row.id,
    brandId: row.brand_id,
    brandName: row.brand_name ?? null,
    action: row.action,
    target: row.target,
    runAt: row.run_at,
    status: row.status,
    attempts: row.attempts,
    result: row.result,
    note: row.note,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

async function handleCreateJob(req, res, user) {
  const body = await readJson(req);
  const brandId = Number(body.brandId);
  const action = asText(body.action).toLowerCase();
  const target = asText(body.target);
  const when = asText(body.runAt);

  if (!ACTIONS[action]) throw new HttpError(400, 'invalid_action', 'Unsupported action.');
  if (target.length < 1 || target.length > 200) throw new HttpError(400, 'invalid_target', 'Target must be 1–200 characters.');

  const brand = requireBrand(user, brandId);
  if (brand.status !== 'active') throw new HttpError(409, 'brand_paused', 'That brand is paused.');

  const queued = q.get(
    `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')
       AND brand_id IN (SELECT id FROM brands WHERE user_id = ?)`, user.id,
  );
  if (queued.n >= 200) throw new HttpError(429, 'queue_full', 'Queue limit reached (200). Let it drain.');

  let runAt;
  if (when) {
    const t = Date.parse(when);
    if (Number.isNaN(t)) throw new HttpError(400, 'invalid_run_at', 'runAt must be an ISO timestamp.');
    runAt = new Date(Math.max(t, Date.now())).toISOString();
  } else {
    const delay = clampInt(body.delaySeconds ?? 0, 0, 30 * 86400);
    runAt = new Date(Date.now() + delay * 1000).toISOString();
  }

  const info = q.run(
    `INSERT INTO jobs (brand_id, action, target, run_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    brand.id, action, target, runAt, nowIso(),
  );
  const row = q.get(
    `SELECT j.*, b.name AS brand_name FROM jobs j JOIN brands b ON b.id = j.brand_id WHERE j.id = ?`,
    Number(info.lastInsertRowid),
  );
  send(res, 201, { job: jobRow(row) });
}

function handleListJobs(res, user, url) {
  const status = url.searchParams.get('status');
  const brandId = url.searchParams.get('brandId');
  const limit = clampInt(url.searchParams.get('limit') ?? 50, 1, 100);

  const where = ['b.user_id = ?'];
  const params = [user.id];
  if (status && JOB_STATUSES.includes(status)) { where.push('j.status = ?'); params.push(status); }
  if (brandId) { where.push('j.brand_id = ?'); params.push(Number(brandId)); }

  const rows = q.all(
    `SELECT j.*, b.name AS brand_name
       FROM jobs j JOIN brands b ON b.id = j.brand_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
               j.run_at DESC
      LIMIT ?`,
    ...params, limit,
  );
  send(res, 200, { jobs: rows.map(jobRow) });
}

function handleCancelJob(res, user, id) {
  const row = q.get(
    `SELECT j.* FROM jobs j JOIN brands b ON b.id = j.brand_id
      WHERE j.id = ? AND b.user_id = ?`, Number(id), user.id,
  );
  if (!row) throw new HttpError(404, 'job_not_found', 'No such job.');
  if (row.status !== 'queued') throw new HttpError(409, 'job_not_cancellable', 'Only queued jobs can be cancelled.');
  q.run(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?`, nowIso(), row.id);
  send(res, 200, { ok: true });
}

/* overview */

function handleOverview(res, user) {
  const today = dayKey();
  const brands = q.all('SELECT id, name, handle, platform, status FROM brands WHERE user_id = ? ORDER BY created_at', user.id);
  const ids = brands.map((b) => b.id);

  const windowStart = shiftDay(today, -29);
  const totals = ids.length
    ? q.get(
      `SELECT COALESCE(SUM(actions),0) AS actions, COALESCE(SUM(engaged),0) AS engaged,
              COALESCE(SUM(follows),0) AS follows, COALESCE(SUM(reach),0) AS reach
         FROM ledger WHERE day >= ? AND brand_id IN (${ids.map(() => '?').join(',')})`,
      windowStart, ...ids)
    : { actions: 0, engaged: 0, follows: 0, reach: 0 };

  const todayAgg = ids.length
    ? q.get(
      `SELECT COALESCE(SUM(actions),0) AS actions, COALESCE(SUM(follows),0) AS follows,
              COALESCE(SUM(reach),0) AS reach
         FROM ledger WHERE day = ? AND brand_id IN (${ids.map(() => '?').join(',')})`, today, ...ids)
    : { actions: 0, follows: 0, reach: 0 };

  const queued = q.get(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'
       AND brand_id IN (SELECT id FROM brands WHERE user_id = ?)`, user.id).n;
  const running = q.get(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'
       AND brand_id IN (SELECT id FROM brands WHERE user_id = ?)`, user.id).n;
  const done24 = q.get(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'done' AND finished_at >= ?
       AND brand_id IN (SELECT id FROM brands WHERE user_id = ?)`,
    new Date(Date.now() - 864e5).toISOString(), user.id).n;

  const series = [];
  for (let i = 13; i >= 0; i--) {
    const day = shiftDay(today, -i);
    const row = ids.length
      ? q.get(
        `SELECT COALESCE(SUM(actions),0) AS actions, COALESCE(SUM(follows),0) AS follows
           FROM ledger WHERE day = ? AND brand_id IN (${ids.map(() => '?').join(',')})`, day, ...ids)
      : { actions: 0, follows: 0 };
    series.push({ day, actions: row.actions, follows: row.follows });
  }

  send(res, 200, {
    kpis: {
      brands: brands.length,
      queued,
      running,
      done24h: done24,
      actionsToday: todayAgg.actions,
      followsToday: todayAgg.follows,
      reachToday: todayAgg.reach,
      actions30d: totals.actions,
      follows30d: totals.follows,
      engagementRate: totals.actions ? Math.round((totals.engaged / totals.actions) * 1000) / 10 : 0,
      paused: brands.filter((b) => b.status !== 'active').length,
    },
    series,
    brands: brands.map((b) => ({
      ...b,
      actionsToday: q.get('SELECT actions FROM ledger WHERE brand_id = ? AND day = ?', b.id, today)?.actions ?? 0,
      queued: q.get(`SELECT COUNT(*) AS n FROM jobs WHERE brand_id = ? AND status = 'queued'`, b.id).n,
    })),
    capacity: { queuedLimit: 200, queuedUsed: queued + running },
  });
}

/* ── scheduler worker ───────────────────────────────────── */

function upsertLedger(brandId, day, { actions = 0, engaged = 0, follows = 0, reach = 0 }) {
  q.run(
    `INSERT INTO ledger (brand_id, day, actions, engaged, follows, reach)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(brand_id, day) DO UPDATE SET
       actions = actions + excluded.actions,
       engaged = engaged + excluded.engaged,
       follows = follows + excluded.follows,
       reach   = reach   + excluded.reach`,
    brandId, day, actions, engaged, follows, reach,
  );
}

function finishJob(job, brand) {
  const spec = ACTIONS[job.action] ?? ACTIONS.view;
  const success = Math.random() < spec.success;
  const day = dayKey();

  if (!success) {
    const attempts = job.attempts + 1;
    if (attempts < 2) {
      q.run(
        `UPDATE jobs SET status = 'queued', attempts = ?, note = ?, run_at = ? WHERE id = ?`,
        attempts, 'provider_error — retrying', new Date(Date.now() + 60_000).toISOString(), job.id,
      );
      return;
    }
    q.run(
      `UPDATE jobs SET status = 'failed', attempts = ?, note = ?, finished_at = ? WHERE id = ?`,
      attempts, 'provider_error — gave up', nowIso(), job.id,
    );
    return;
  }

  const engaged = Math.random() < spec.engaged ? 1 : 0;
  const follows = job.action === 'follow' && engaged ? 1 : 0;
  const reach = spec.reach + randomInt(0, 5);

  upsertLedger(brand.id, day, { actions: 1, engaged, follows, reach });
  q.run(
    `UPDATE jobs SET status = 'done', attempts = attempts + 1, result = ?, note = ?, finished_at = ? WHERE id = ?`,
    engaged ? 'engaged' : 'delivered',
    engaged ? `${spec.label} landed — ${follows ? 'followed back' : 'engagement recorded'}` : `${spec.label} delivered, no return yet`,
    nowIso(), job.id,
  );
}

function runDueJobs() {
  const due = q.all(
    `SELECT j.*, b.id AS b_id, b.max_per_hour, b.max_per_day, b.status AS b_status
       FROM jobs j JOIN brands b ON b.id = j.brand_id
      WHERE j.status = 'queued' AND j.run_at <= ?
      ORDER BY j.run_at LIMIT 6`,
    nowIso(),
  );

  for (const job of due) {
    const brand = { id: job.b_id, max_per_hour: job.max_per_hour, max_per_day: job.max_per_day };

    if (job.b_status !== 'active') {
      q.run(`UPDATE jobs SET note = ? WHERE id = ?`, 'brand paused — holding', job.id);
      q.run(`UPDATE jobs SET run_at = ? WHERE id = ?`, new Date(Date.now() + 10 * 60_000).toISOString(), job.id);
      continue;
    }

    const dayActions = q.get('SELECT actions FROM ledger WHERE brand_id = ? AND day = ?', brand.id, dayKey())?.actions ?? 0;
    if (dayActions >= brand.max_per_day) {
      q.run(
        `UPDATE jobs SET note = ?, run_at = ? WHERE id = ?`,
        'daily cadence reached — deferring', new Date(Date.now() + 30 * 60_000).toISOString(), job.id,
      );
      continue;
    }

    const lastHour = q.get(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE brand_id = ? AND status IN ('done','failed') AND finished_at >= ?`,
      brand.id, new Date(Date.now() - 3600_000).toISOString(),
    ).n;
    if (lastHour >= brand.max_per_hour) {
      q.run(
        `UPDATE jobs SET note = ?, run_at = ? WHERE id = ?`,
        'hourly cadence reached — deferring', new Date(Date.now() + 15 * 60_000).toISOString(), job.id,
      );
      continue;
    }

    q.run(`UPDATE jobs SET status = 'running', note = ? WHERE id = ?`, 'reaching target', job.id);
    const delay = 700 + randomInt(0, 900);
    setTimeout(() => {
      try { finishJob(job, brand); } catch (err) {
        console.error('job failed', job.id, err);
        q.run(`UPDATE jobs SET status = 'failed', note = ?, finished_at = ? WHERE id = ?`,
          'internal_error', nowIso(), job.id);
      }
    }, delay);
  }
}

/* ── static files ───────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel);

  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden', 'Forbidden.');

  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    return fail(res, 404, 'not_found', 'Not found.');
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(body);
  } catch {
    fail(res, 404, 'not_found', 'Not found.');
  }
}

/* ── server ─────────────────────────────────────────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';

  try {
    if (pathname === '/api/health') {
      const count = q.get('SELECT COUNT(*) AS n FROM users').n;
      return send(res, 200, { ok: true, service: 'understory', users: count, time: nowIso() });
    }

    if (pathname === '/api/auth/register' && method === 'POST') return await handleRegister(req, res);
    if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/auth/logout' && method === 'POST') return handleLogout(req, res);

    /* Session probe: 200 with a null user when signed out, so the console's
       boot check doesn't log a spurious 401 in every visitor's console. */
    if (pathname === '/api/me' && method === 'GET') {
      const user = userForToken(readSessionCookie(req));
      return send(res, 200, { user: user ?? null });
    }

    if (pathname === '/api/overview' && method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return;
      return handleOverview(res, user);
    }

    if (pathname === '/api/brands') {
      const user = requireUser(req, res);
      if (!user) return;
      if (method === 'GET') return handleListBrands(res, user);
      if (method === 'POST') return await handleCreateBrand(req, res, user);
      return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
    }

    const brandMatch = pathname.match(/^\/api\/brands\/(\d+)$/);
    if (brandMatch) {
      const user = requireUser(req, res);
      if (!user) return;
      if (method === 'PATCH') return await handleUpdateBrand(req, res, user, brandMatch[1]);
      if (method === 'DELETE') return handleDeleteBrand(res, user, brandMatch[1]);
      return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
    }

    if (pathname === '/api/jobs') {
      const user = requireUser(req, res);
      if (!user) return;
      if (method === 'GET') return handleListJobs(res, user, url);
      if (method === 'POST') return await handleCreateJob(req, res, user);
      return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
    }

    const cancelMatch = pathname.match(/^\/api\/jobs\/(\d+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return;
      return handleCancelJob(res, user, cancelMatch[1]);
    }

    if (pathname.startsWith('/api/')) return fail(res, 404, 'unknown_endpoint', 'Unknown endpoint.');

    if (method === 'GET' || method === 'HEAD') return await serveStatic(req, res, pathname);

    return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
  } catch (err) {
    if (err instanceof HttpError) return fail(res, err.status, err.code, err.message);
    console.error('unhandled', err);
    return fail(res, 500, 'internal_error', 'Something went wrong.');
  }
});

/* crash recovery: nothing should be stuck "running" across a restart */
q.run(`UPDATE jobs SET status = 'queued', note = 'requeued after restart' WHERE status = 'running'`);

setInterval(runDueJobs, 2500).unref();

/* ── demo seed ──────────────────────────────────────────── */

async function seed() {
  const email = 'demo@understory.test';
  if (q.get('SELECT id FROM users WHERE email = ?', email)) {
    console.log('seed: demo user already exists');
    return;
  }
  const info = q.run(
    'INSERT INTO users (email, password_hash, plan, created_at) VALUES (?, ?, ?, ?)',
    email, hashPassword('understory-demo'), 'pro', nowIso(),
  );
  const userId = Number(info.lastInsertRowid);

  const brands = [
    ['Fern & Field', 'fernandfield', 'instagram'],
    ['Northwind Studio', 'northwind', 'linkedin'],
    ['Clay Court Coffee', 'claycourt', 'tiktok'],
  ];
  const brandIds = brands.map(([name, handle, platform]) =>
    Number(q.run(
      `INSERT INTO brands (user_id, name, handle, platform, created_at) VALUES (?, ?, ?, ?, ?)`,
      userId, name, handle, platform, nowIso(),
    ).lastInsertRowid));

  const today = dayKey();
  for (let d = 13; d >= 0; d--) {
    const day = shiftDay(today, -d);
    brandIds.forEach((brandId, i) => {
      const base = 6 + i * 3;
      const actions = base + randomInt(0, 8) + Math.round((13 - d) * 0.7);
      const engaged = Math.round(actions * (0.22 + Math.random() * 0.16));
      const follows = Math.round(engaged * (0.4 + Math.random() * 0.25));
      upsertLedger(brandId, day, { actions, engaged, follows, reach: actions * 7 + randomInt(0, 20) });
    });
  }

  for (const brandId of brandIds) {
    for (let i = 0; i < 4; i++) {
      q.run(
        `INSERT INTO jobs (brand_id, action, target, run_at, status, created_at, finished_at, attempts, result, note)
         VALUES (?, ?, ?, ?, 'done', ?, ?, 1, ?, ?)`,
        brandId,
        ['follow', 'like', 'comment', 'view'][i % 4],
        ['@earlybird.studio', '@thestudio.co', '@northloop', '@quietbrand'][i % 4],
        new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
        new Date(Date.now() - (i + 2) * 3600_000).toISOString(),
        new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
        i % 3 === 0 ? 'engaged' : 'delivered',
        i % 3 === 0 ? 'Follow landed — followed back' : 'Delivered, no return yet',
      );
    }
    q.run(
      `INSERT INTO jobs (brand_id, action, target, run_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      brandId, 'follow', '@newleaf.journal', new Date(Date.now() + 120_000).toISOString(), nowIso(),
    );
  }

  console.log(`seed: demo@understory.test / understory-demo (${brands.length} brands, 14 days of history)`);
}

if (process.argv.includes('--seed')) await seed();

server.listen(PORT, () => {
  console.log(`understory listening on http://127.0.0.1:${PORT}`);
  console.log(`db: ${process.env.DB_PATH ?? 'data/understory.db'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
