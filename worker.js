// Stuyvesant Rod & Gun Club — site worker
// Public API:  GET /api/content          -> hours, banner, events, photos (JSON)
//              GET /photos/<key>          -> photo from R2
// Admin API:   /api/admin/*  (officer login required)
// Everything else is served from /public (static assets).

const SESSION_DAYS = 30;
const PBKDF2_ITER = 100000;
const CATS = ['training', 'club', 'meeting', 'closure'];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith('/api/') || p.startsWith('/photos/')) await init(env);
      if (p === '/api/content' && req.method === 'GET') return json(await content(env), 200, { 'Cache-Control': 'no-store' });
      if (p.startsWith('/photos/') && req.method === 'GET') return photo(env, p.slice(8));
      if (p.startsWith('/api/admin/')) return admin(req, env, p.slice(11));
      if (p.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error: ' + (e && e.message || e) }, 500);
    }
    return env.ASSETS.fetch(req);
  }
};

// ---------- setup ----------
let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT NOT NULL, date TEXT NOT NULL, end_date TEXT, start TEXT, "end" TEXT, descr TEXT, updated_at TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, r2key TEXT NOT NULL, caption TEXT, sort INTEGER DEFAULT 0, created_at TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS officers (email TEXT PRIMARY KEY, name TEXT, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT, fails INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL)`),
  ]);
  const seeded = await env.DB.prepare(`SELECT value FROM settings WHERE key='seeded'`).first();
  if (!seeded) {
    // First run: copy the starter content from data.json into the database.
    let d = {};
    try { d = await (await env.ASSETS.fetch(new Request('https://assets/data.json'))).json(); } catch (e) {}
    const stmts = [
      setS(env, 'hours', d.hours || { confirmed: false, note: '', days: Array.from({ length: 7 }, () => ({ closed: true })) }),
      setS(env, 'banner', d.banner || { on: false, text: '' }),
      setS(env, 'notify', { group: '', signature: 'Stuyvesant Rod & Gun Club' }),
      setS(env, 'cover', { photoId: null }),
      setS(env, 'seeded', new Date().toISOString()),
    ];
    for (const e of (d.events || [])) stmts.push(env.DB.prepare(`INSERT INTO events (title,category,date,end_date,start,"end",descr,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(e.title, e.category || 'club', e.date, e.endDate || '', e.start || '', e.end || '', e.desc || '', new Date().toISOString()));
    await env.DB.batch(stmts);
  }
  ready = true;
}
const setS = (env, k, v) => env.DB.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(k, JSON.stringify(v));
async function getS(env, k, dflt) { const r = await env.DB.prepare(`SELECT value FROM settings WHERE key=?`).bind(k).first(); return r ? JSON.parse(r.value) : dflt; }

// ---------- public ----------
async function content(env) {
  const [hours, banner, cover] = await Promise.all([getS(env, 'hours', null), getS(env, 'banner', null), getS(env, 'cover', {})]);
  const ev = (await env.DB.prepare(`SELECT * FROM events ORDER BY date, start`).all()).results;
  const ph = (await env.DB.prepare(`SELECT * FROM photos ORDER BY sort, id`).all()).results;
  const photos = ph.map(r => ({ id: r.id, src: '/photos/' + r.r2key, caption: r.caption || '' }));
  const c = photos.find(x => x.id === cover.photoId);
  return {
    hours, banner,
    events: ev.map(evOut),
    photos,
    cover: c ? c.src : ''
  };
}
const evOut = r => ({ id: r.id, title: r.title, category: r.category, date: r.date, endDate: r.end_date || '', start: r.start || '', end: r.end || '', desc: r.descr || '' });

async function photo(env, key) {
  if (!/^[a-z0-9-]+\.(jpg|jpeg|png|webp)$/i.test(key)) return new Response('Not found', { status: 404 });
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const h = new Headers(); obj.writeHttpMetadata(h); h.set('etag', obj.httpEtag); h.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers: h });
}

// ---------- admin ----------
async function admin(req, env, route) {
  const m = req.method;
  // CSRF guard: admin writes must be same-origin JSON/blob calls from our page.
  if (m !== 'GET' && req.headers.get('X-SRGC') !== '1') return json({ error: 'Bad request' }, 400);

  if (route === 'status' && m === 'GET') {
    const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM officers`).first()).n;
    const me = await currentOfficer(req, env);
    return json({ needsSetup: n === 0, setupEnabled: !!env.SETUP_KEY, me });
  }
  if (route === 'setup' && m === 'POST') {
    const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM officers`).first()).n;
    const b = await req.json();
    if (!env.SETUP_KEY) return json({ error: 'Setup key is not configured in Cloudflare. See the guide.' }, 403);
    if (!safeEq(String(b.setupKey || ''), env.SETUP_KEY)) return json({ error: 'That setup key is wrong.' }, 403);
    // With the setup key an account owner can always add (or reset) an officer, even if everyone is locked out.
    const err = validOfficer(b); if (err) return json({ error: err }, 400);
    await putOfficer(env, b.email, b.name, b.password);
    return login(env, b.email, n);
  }
  if (route === 'login' && m === 'POST') {
    const b = await req.json();
    const email = String(b.email || '').trim().toLowerCase();
    const o = await env.DB.prepare(`SELECT * FROM officers WHERE email=?`).bind(email).first();
    const now = Date.now();
    if (o && o.locked_until > now) return json({ error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
    if (!o || !(await checkPw(String(b.password || ''), o.salt, o.hash))) {
      if (o) await env.DB.prepare(`UPDATE officers SET fails=fails+1, locked_until=CASE WHEN fails+1>=8 THEN ? ELSE 0 END WHERE email=?`).bind(now + 15 * 60e3, email).run();
      return json({ error: 'Email or password is wrong.' }, 401);
    }
    await env.DB.prepare(`UPDATE officers SET fails=0, locked_until=0 WHERE email=?`).bind(email).run();
    return login(env, email);
  }
  if (route === 'logout' && m === 'POST') {
    const t = cookie(req, 'srgc_s'); if (t) await env.DB.prepare(`DELETE FROM sessions WHERE token=?`).bind(t).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'srgc_s=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  }

  // Everything below needs a signed-in officer.
  const me = await currentOfficer(req, env);
  if (!me) return json({ error: 'Please sign in.' }, 401);

  if (route === 'content' && m === 'GET') {
    const c = await content(env);
    c.notify = await getS(env, 'notify', { group: '' });
    c.coverId = (await getS(env, 'cover', {})).photoId || null;
    c.officers = (await env.DB.prepare(`SELECT email,name,created_at FROM officers ORDER BY name`).all()).results;
    return json(c);
  }
  if (route === 'hours' && m === 'PUT') {
    const b = await req.json();
    if (!Array.isArray(b.days) || b.days.length !== 7) return json({ error: 'Hours need all 7 days.' }, 400);
    const days = b.days.map(d => d.closed ? { closed: true } : { closed: false, open: hhmm(d.open), close: hhmm(d.close) });
    for (const d of days) if (!d.closed && (!d.open || !d.close || d.close <= d.open)) return json({ error: 'Each open day needs a closing time after its opening time.' }, 400);
    await setS(env, 'hours', { days, note: str(b.note, 500), confirmed: !!b.confirmed }).run();
    return json({ ok: true });
  }
  if (route === 'banner' && m === 'PUT') {
    const b = await req.json();
    await setS(env, 'banner', { on: !!b.on, text: str(b.text, 300) }).run();
    return json({ ok: true });
  }
  if (route === 'notify' && m === 'PUT') {
    const b = await req.json();
    const group = String(b.group || '').trim();
    if (group && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(group)) return json({ error: 'That group address doesn\'t look like an email address.' }, 400);
    await setS(env, 'notify', { group, signature: str(b.signature, 200) }).run();
    return json({ ok: true });
  }
  if (route === 'events' && m === 'POST' || route.startsWith('events/') && m === 'PUT') {
    const b = await req.json();
    const e = { title: str(b.title, 150), category: CATS.includes(b.category) ? b.category : 'club', date: ymd(b.date), endDate: ymd(b.endDate), start: hhmm(b.start), end: hhmm(b.end), desc: str(b.desc, 2000) };
    if (!e.title || !e.date) return json({ error: 'An event needs a title and a date.' }, 400);
    if (e.endDate && e.endDate < e.date) return json({ error: 'The end date is before the start date.' }, 400);
    const now = new Date().toISOString();
    if (m === 'POST') await env.DB.prepare(`INSERT INTO events (title,category,date,end_date,start,"end",descr,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(e.title, e.category, e.date, e.endDate, e.start, e.end, e.desc, now).run();
    else await env.DB.prepare(`UPDATE events SET title=?,category=?,date=?,end_date=?,start=?,"end"=?,descr=?,updated_at=? WHERE id=?`).bind(e.title, e.category, e.date, e.endDate, e.start, e.end, e.desc, now, int(route.slice(7))).run();
    return json({ ok: true });
  }
  if (route.startsWith('events/') && m === 'DELETE') {
    await env.DB.prepare(`DELETE FROM events WHERE id=?`).bind(int(route.slice(7))).run();
    return json({ ok: true });
  }
  if (route === 'photos' && m === 'POST') {
    const type = (req.headers.get('Content-Type') || '').split(';')[0];
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
    if (!ext) return json({ error: 'Photos must be JPEG, PNG or WebP.' }, 400);
    const len = +req.headers.get('Content-Length') || 0;
    if (len > 15 * 1024 * 1024) return json({ error: 'That photo is over 15 MB.' }, 400);
    const key = crypto.randomUUID() + '.' + ext;
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 15 * 1024 * 1024) return json({ error: 'That photo is over 15 MB.' }, 400);
    await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
    const cap = str(new URL(req.url).searchParams.get('caption'), 200);
    await env.DB.prepare(`INSERT INTO photos (r2key,caption,sort,created_at) VALUES (?,?,?,?)`).bind(key, cap, Math.floor(Date.now() / 1000), new Date().toISOString()).run();
    return json({ ok: true });
  }
  if (route.startsWith('photos/') && m === 'PUT') {
    const b = await req.json();
    await env.DB.prepare(`UPDATE photos SET caption=? WHERE id=?`).bind(str(b.caption, 200), int(route.slice(7))).run();
    return json({ ok: true });
  }
  if (route.startsWith('photos/') && m === 'DELETE') {
    const id = int(route.slice(7));
    const r = await env.DB.prepare(`SELECT r2key FROM photos WHERE id=?`).bind(id).first();
    if (r) { await env.PHOTOS.delete(r.r2key); await env.DB.prepare(`DELETE FROM photos WHERE id=?`).bind(id).run(); }
    const cov = await getS(env, 'cover', {}); if (cov.photoId === id) await setS(env, 'cover', { photoId: null }).run();
    return json({ ok: true });
  }
  if (route === 'cover' && m === 'PUT') {
    const b = await req.json();
    await setS(env, 'cover', { photoId: b.photoId ? int(b.photoId) : null }).run();
    return json({ ok: true });
  }
  if (route === 'officers' && m === 'POST') {
    const b = await req.json();
    const err = validOfficer(b); if (err) return json({ error: err }, 400);
    const exists = await env.DB.prepare(`SELECT 1 FROM officers WHERE email=?`).bind(b.email.trim().toLowerCase()).first();
    if (exists && !b.reset) return json({ error: 'That officer already exists. Use "Reset password" instead.' }, 400);
    await putOfficer(env, b.email, b.name, b.password);
    if (exists) await env.DB.prepare(`DELETE FROM sessions WHERE email=?`).bind(b.email.trim().toLowerCase()).run();
    return json({ ok: true });
  }
  if (route.startsWith('officers/') && m === 'DELETE') {
    const email = decodeURIComponent(route.slice(9)).toLowerCase();
    const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM officers`).first()).n;
    if (n <= 1) return json({ error: 'You can\'t remove the last officer.' }, 400);
    await env.DB.batch([env.DB.prepare(`DELETE FROM officers WHERE email=?`).bind(email), env.DB.prepare(`DELETE FROM sessions WHERE email=?`).bind(email)]);
    return json({ ok: true });
  }
  if (route === 'password' && m === 'PUT') {
    const b = await req.json();
    const o = await env.DB.prepare(`SELECT * FROM officers WHERE email=?`).bind(me.email).first();
    if (!(await checkPw(String(b.current || ''), o.salt, o.hash))) return json({ error: 'Your current password is wrong.' }, 400);
    if (String(b.password || '').length < 10) return json({ error: 'Use at least 10 characters for the new password.' }, 400);
    await putOfficer(env, me.email, o.name, b.password);
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}

// ---------- auth helpers ----------
function validOfficer(b) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email || '').trim())) return 'Enter a valid email address.';
  if (!String(b.name || '').trim()) return 'Enter the officer\'s name.';
  if (String(b.password || '').length < 10) return 'Use a password of at least 10 characters.';
  return null;
}
async function putOfficer(env, email, name, pw) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(pw, salt);
  await env.DB.prepare(`INSERT INTO officers (email,name,salt,hash,created_at) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, salt=excluded.salt, hash=excluded.hash, fails=0, locked_until=0`)
    .bind(email.trim().toLowerCase(), str(name, 100), salt, hash, new Date().toISOString()).run();
}
async function login(env, email) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
  const exp = Date.now() + SESSION_DAYS * 864e5;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires < ?`).bind(Date.now()),
    env.DB.prepare(`INSERT INTO sessions (token,email,expires) VALUES (?,?,?)`).bind(token, email.trim().toLowerCase(), exp),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': `srgc_s=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}` });
}
async function currentOfficer(req, env) {
  const t = cookie(req, 'srgc_s'); if (!t) return null;
  const r = await env.DB.prepare(`SELECT o.email, o.name FROM sessions s JOIN officers o ON o.email=s.email WHERE s.token=? AND s.expires>?`).bind(t, Date.now()).first();
  return r || null;
}
async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: ub64(salt), iterations: PBKDF2_ITER }, k, 256);
  return b64(new Uint8Array(bits));
}
async function checkPw(pw, salt, hash) { return safeEq(await pbkdf2(pw, salt), hash); }
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const b64 = u => btoa(String.fromCharCode(...u));
const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function cookie(req, name) { const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return m ? m[1] : null; }

// ---------- misc ----------
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const int = v => parseInt(v, 10) || 0;
const ymd = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '';
const hhmm = v => /^\d{2}:\d{2}$/.test(v || '') ? v : '';
function json(o, status = 200, h = {}) { return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...h } }); }
