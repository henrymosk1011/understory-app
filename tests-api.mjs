// End-to-end API tests against a running Understory server.
const BASE = process.env.BASE ?? 'http://127.0.0.1:8790';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
};

function jar() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(path, { method = 'GET', body } = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie?.() ?? [];
      for (const c of set) {
        const pair = c.split(';')[0];
        if (pair.startsWith('us_session=')) cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      return { status: res.status, json, text, headers: res.headers };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anon = jar();
const alice = jar();
const bob = jar();

// health
const health = await anon.call('/api/health');
ok('health returns ok', health.status === 200 && health.json?.ok === true);
ok('security headers present', health.headers.get('x-content-type-options') === 'nosniff');
ok('CSP present', String(health.headers.get('content-security-policy')).includes("default-src 'self'"));

// static
const home = await fetch(BASE + '/');
const html = await home.text();
ok('serves console html', home.status === 200 && html.includes('Understory — Console'));

// auth required
ok('overview requires auth', (await anon.call('/api/overview')).status === 401);
ok('jobs require auth', (await anon.call('/api/jobs')).status === 401);
ok('brands require auth', (await anon.call('/api/brands')).status === 401);

// validation
ok('rejects bad email', (await anon.call('/api/auth/register', { method: 'POST', body: { email: 'nope', password: 'longenough1' } })).status === 400);
ok('rejects short password', (await anon.call('/api/auth/register', { method: 'POST', body: { email: 'a@b.co', password: 'short' } })).status === 400);

// register
const reg = await alice.call('/api/auth/register', { method: 'POST', body: { email: 'alice@test.dev', password: 'correct-horse-9' } });
ok('register 201', reg.status === 201, JSON.stringify(reg.json));
ok('register sets session cookie', alice.cookie.startsWith('us_session='));
const me = await alice.call('/api/me');
ok('me returns user', me.status === 200 && me.json.user.email === 'alice@test.dev');

// duplicate email
ok('duplicate email 409', (await anon.call('/api/auth/register', { method: 'POST', body: { email: 'alice@test.dev', password: 'correct-horse-9' } })).status === 409);

// login paths
const badLogin = await anon.call('/api/auth/login', { method: 'POST', body: { email: 'alice@test.dev', password: 'wrong-password' } });
ok('bad password 401', badLogin.status === 401);
const goodLogin = await anon.call('/api/auth/login', { method: 'POST', body: { email: 'alice@test.dev', password: 'correct-horse-9' } });
ok('good login 200', goodLogin.status === 200);

// brands
const created = await alice.call('/api/brands', { method: 'POST', body: { name: 'Fern & Field', handle: '@fernandfield', platform: 'instagram' } });
ok('create brand 201', created.status === 201, JSON.stringify(created.json));
ok('handle normalised', created.json?.brand?.handle === 'fernandfield');
const brandId = created.json.brand.id;

ok('rejects bad platform', (await alice.call('/api/brands', { method: 'POST', body: { name: 'X', handle: 'xx', platform: 'myspace' } })).status === 400);
ok('rejects duplicate handle', (await alice.call('/api/brands', { method: 'POST', body: { name: 'Dup', handle: 'fernandfield', platform: 'instagram' } })).status === 409);

// tenant isolation
await bob.call('/api/auth/register', { method: 'POST', body: { email: 'bob@test.dev', password: 'another-horse-8' } });
const bobBrands = await bob.call('/api/brands');
ok("bob cannot see alice's brands", bobBrands.json.brands.length === 0);
ok("bob cannot patch alice's brand", (await bob.call(`/api/brands/${brandId}`, { method: 'PATCH', body: { name: 'pwned' } })).status === 404);
ok("bob cannot schedule on alice's brand", (await bob.call('/api/jobs', { method: 'POST', body: { brandId, action: 'follow', target: '@x' } })).status === 404);
ok("bob cannot delete alice's brand", (await bob.call(`/api/brands/${brandId}`, { method: 'DELETE' })).status === 404);

// jobs
const job = await alice.call('/api/jobs', { method: 'POST', body: { brandId, action: 'follow', target: '@earlybird.studio', delaySeconds: 0 } });
ok('create job 201', job.status === 201, JSON.stringify(job.json));
ok('job starts queued', ['queued', 'running'].includes(job.json?.job?.status));

ok('rejects unknown action', (await alice.call('/api/jobs', { method: 'POST', body: { brandId, action: 'shout', target: '@x' } })).status === 400);
ok('rejects empty target', (await alice.call('/api/jobs', { method: 'POST', body: { brandId, action: 'like', target: '' } })).status === 400);

// worker executes
let done = null;
for (let i = 0; i < 20 && !done; i++) {
  await sleep(700);
  const list = await alice.call('/api/jobs?limit=10');
  done = list.json.jobs.find((j) => j.id === job.json.job.id && ['done', 'failed'].includes(j.status));
}
ok('worker executes the job', Boolean(done), done ? done.status : 'still queued');
ok('job records a result', Boolean(done?.result) || done?.status === 'failed');

// cancellation
const later = await alice.call('/api/jobs', { method: 'POST', body: { brandId, action: 'like', target: '@later.corp', delaySeconds: 3600 } });
const cancelled = await alice.call(`/api/jobs/${later.json.job.id}/cancel`, { method: 'POST' });
ok('cancel queued job 200', cancelled.status === 200);
ok('cancelled job is cancelled', (await alice.call('/api/jobs?status=cancelled')).json.jobs.some((j) => j.id === later.json.job.id));
ok('cannot cancel twice', (await alice.call(`/api/jobs/${later.json.job.id}/cancel`, { method: 'POST' })).status === 409);

// pause holds the queue
await alice.call(`/api/brands/${brandId}`, { method: 'PATCH', body: { status: 'paused' } });
const pausedJob = await alice.call('/api/jobs', { method: 'POST', body: { brandId, action: 'view', target: '@paused.test' } });
ok('paused brand rejects new jobs', pausedJob.status === 409);
await alice.call(`/api/brands/${brandId}`, { method: 'PATCH', body: { status: 'active' } });

// overview
const overview = await alice.call('/api/overview');
ok('overview 200', overview.status === 200);
ok('overview has 14-day series', overview.json.series.length === 14);
ok('overview counts the brand', overview.json.kpis.brands === 1);
ok('overview counts today actions', overview.json.kpis.actionsToday >= 1, String(overview.json.kpis.actionsToday));
ok('capacity reported', overview.json.capacity.queuedLimit === 200);

// logout
await alice.call('/api/auth/logout', { method: 'POST' });
const afterLogout = await alice.call('/api/me');
ok('logout clears session', afterLogout.status === 200 && afterLogout.json.user === null);

// rate limiting (fresh ip+email key, 11 wrong attempts)
let limited = false;
for (let i = 0; i < 11; i++) {
  const r = await anon.call('/api/auth/login', { method: 'POST', body: { email: 'bob@test.dev', password: 'wrong-' + i } });
  if (r.status === 429) { limited = true; break; }
}
ok('login throttles after repeated failures', limited);
ok('throttle blocks the correct password too', (await anon.call('/api/auth/login', { method: 'POST', body: { email: 'bob@test.dev', password: 'another-horse-8' } })).status === 429);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
