'use strict';
/* Servidor do Cesta Livre: contas (nick + senha), sessões e perfil salvo na nuvem.
   Sem dependências: só módulos nativos do Node 18+. Serve o jogo em / e a API em /api/*. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UP_KEY = 'cesta-livre-db';
const SESSION_MS = 90 * 24 * 3600 * 1000;
const NICK_RE = /^[A-Za-z0-9_.-]{3,16}$/;
const INDEX = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find((f) => fs.existsSync(f)) || path.join(__dirname, 'index.html');

let db = { users: {}, sessions: {} };

/* ---------- armazenamento ---------- */
async function upstash(cmd) {
  const r = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error('Upstash HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('Upstash: ' + j.error);
  return j.result;
}
async function loadDb() {
  let raw = null;
  if (UP_URL && UP_TOKEN) raw = await upstash(['GET', UP_KEY]);
  else if (fs.existsSync(DB_FILE)) raw = fs.readFileSync(DB_FILE, 'utf8');
  if (raw) {
    const d = JSON.parse(raw);
    if (d && typeof d === 'object') db = { users: d.users || {}, sessions: d.sessions || {} };
  }
  pruneSessions();
}
function pruneSessions() {
  const now = Date.now();
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].exp < now) delete db.sessions[k];
}
let persistTimer = null, persisting = false, persistAgain = false;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(doPersist, 300);
}
async function doPersist() {
  if (persisting) { persistAgain = true; return; }
  persisting = true;
  try {
    const json = JSON.stringify(db);
    if (UP_URL && UP_TOKEN) await upstash(['SET', UP_KEY, json]);
    else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, DB_FILE);
    }
  } catch (e) {
    console.error('Falha ao salvar:', e.message);
    persistAgain = true;
  }
  persisting = false;
  if (persistAgain) { persistAgain = false; persistTimer = setTimeout(doPersist, 3000); }
}

/* ---------- utilidades ---------- */
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DUMMY_SALT = crypto.randomBytes(16);

const hits = new Map();
function limited(key, max, windowMs, add) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  if (add) h.n++;
  return h.n >= max;
}
function clearHits(key) { hits.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  pruneSessions();
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return x || req.socket.remoteAddress || 'x';
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/* ---------- perfil ---------- */
const int = (v, a, b) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a; };
const flt = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
function zeroTotals() { return { games: 0, points: 0, made: 0, att: 0, threes: 0, streak: 0, wins: 0, losses: 0, ties: 0 }; }
function newProfile() {
  return {
    v: 1, best: 0, char: 'fogueteiro', codes: [],
    cfg: { sens: 1, fov: 0, invert: false, vib: true, hq: true, hints: true },
    muted: false, mode: 'timed', difficulty: 'normal', team: 'A', totals: zeroTotals(),
  };
}
function cleanProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  const t = p.totals && typeof p.totals === 'object' ? p.totals : {};
  const c = p.cfg && typeof p.cfg === 'object' ? p.cfg : {};
  const totals = {};
  for (const k of Object.keys(zeroTotals())) totals[k] = int(t[k], 0, 10000000);
  return {
    v: 1,
    best: int(p.best, 0, 100000),
    char: typeof p.char === 'string' && /^[a-z0-9_-]{1,24}$/.test(p.char) ? p.char : 'fogueteiro',
    codes: Array.isArray(p.codes)
      ? [...new Set(p.codes.filter((x) => typeof x === 'string' && /^[A-Z0-9]{1,24}$/.test(x)))].slice(0, 12) : [],
    cfg: {
      sens: flt(c.sens, 0.4, 2.2, 1), fov: int(c.fov, -10, 16),
      invert: c.invert === true, vib: c.vib !== false, hq: c.hq !== false, hints: c.hints !== false,
    },
    muted: p.muted === true,
    mode: ['timed', 'free', 'vs'].includes(p.mode) ? p.mode : 'timed',
    difficulty: ['easy', 'normal', 'hard'].includes(p.difficulty) ? p.difficulty : 'normal',
    team: p.team === 'B' ? 'B' : 'A',
    totals,
  };
}
const pub = (u) => Object.assign({}, u.profile, { rev: u.rev });

/* ---------- sessões ---------- */
function newSession(lk) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha(token)] = { lk, exp: Date.now() + SESSION_MS };
  return token;
}
function authed(req) {
  const m = /^Bearer (\S{20,100})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.sessions[sha(m[1])];
  if (!s || s.exp < Date.now() || !db.users[s.lk]) return null;
  return { lk: s.lk, user: db.users[s.lk], hash: sha(m[1]) };
}

/* ---------- API ---------- */
async function api(req, res, pathname) {
  const ip = clientIp(req);
  try {
    if (pathname === '/api/register' && req.method === 'POST') {
      if (limited('reg|' + ip, 10, 3600e3, true)) return send(res, 429, { error: 'Muitas contas criadas daqui. Tente mais tarde.' });
      const b = await readBody(req, 2048);
      const nick = String(b.nick || '').trim(), pass = String(b.pass || '');
      if (!NICK_RE.test(nick)) return send(res, 400, { error: 'Nick: 3 a 16 caracteres, só letras, números, _ . ou -' });
      if (pass.length < 4 || pass.length > 64) return send(res, 400, { error: 'A senha precisa ter de 4 a 64 caracteres.' });
      const lk = nick.toLowerCase();
      if (db.users[lk]) return send(res, 409, { error: 'Esse nick já está em uso. Escolha outro ou entre na conta.' });
      const salt = crypto.randomBytes(16);
      const hash = (await scrypt(pass, salt)).toString('hex');
      if (db.users[lk]) return send(res, 409, { error: 'Esse nick já está em uso. Escolha outro ou entre na conta.' });
      db.users[lk] = { nick, salt: salt.toString('hex'), hash, created: Date.now(), rev: 1, profile: newProfile() };
      const token = newSession(lk);
      persist();
      return send(res, 201, { token, nick, profile: pub(db.users[lk]) });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const b = await readBody(req, 2048);
      const nick = String(b.nick || '').trim(), pass = String(b.pass || '');
      const lk = nick.toLowerCase();
      const key = 'login|' + ip + '|' + lk;
      if (limited(key, 8, 10 * 60e3, false) || limited('loginip|' + ip, 40, 10 * 60e3, false))
        return send(res, 429, { error: 'Muitas tentativas. Espere alguns minutos.' });
      const u = NICK_RE.test(nick) ? db.users[lk] : null;
      const salt = u ? Buffer.from(u.salt, 'hex') : DUMMY_SALT;
      const got = await scrypt(pass.slice(0, 64), salt);
      const ok = u && crypto.timingSafeEqual(got, Buffer.from(u.hash, 'hex'));
      if (!ok) {
        limited(key, 8, 10 * 60e3, true); limited('loginip|' + ip, 40, 10 * 60e3, true);
        return send(res, 401, { error: u ? 'Senha incorreta.' : 'Conta não encontrada. Toque em Criar conta.' });
      }
      clearHits(key);
      const token = newSession(lk);
      persist();
      return send(res, 200, { token, nick: u.nick, profile: pub(u) });
    }
    if (pathname === '/api/profile' && (req.method === 'GET' || req.method === 'PUT')) {
      const a = authed(req);
      if (!a) return send(res, 401, { error: 'Sessão expirada. Entre novamente.' });
      if (req.method === 'GET') return send(res, 200, { nick: a.user.nick, profile: pub(a.user) });
      const b = await readBody(req, 16384);
      if (Number(b.rev) !== a.user.rev) return send(res, 409, { error: 'Dados mais novos no servidor.', profile: pub(a.user) });
      a.user.profile = cleanProfile(b);
      a.user.rev++;
      persist();
      return send(res, 200, { rev: a.user.rev });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      const a = authed(req);
      if (a) { delete db.sessions[a.hash]; persist(); }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Não encontrado.' });
  } catch (e) {
    if (e && e.status) return send(res, e.status, { error: e.status === 413 ? 'Dados grandes demais.' : 'Requisição inválida.' });
    console.error(e);
    return send(res, 500, { error: 'Erro no servidor.' });
  }
}

/* ---------- página do jogo ---------- */
let htmlCache = null;
function serveIndex(req, res) {
  try {
    const st = fs.statSync(INDEX);
    if (!htmlCache || htmlCache.mtime !== st.mtimeMs) {
      const raw = fs.readFileSync(INDEX);
      htmlCache = { mtime: st.mtimeMs, raw, gz: zlib.gzipSync(raw) };
    }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Accept-Encoding',
      ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(gz ? htmlCache.gz : htmlCache.raw);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('public/index.html não encontrado.');
  }
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname.startsWith('/api/')) return api(req, res, pathname);
  if (pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if ((pathname === '/' || pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) return serveIndex(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Não encontrado');
});

loadDb().then(() => {
  server.listen(PORT, () => console.log('Cesta Livre no ar na porta ' + PORT + (UP_URL ? ' (banco: Upstash)' : ' (banco: arquivo ' + DB_FILE + ')')));
}).catch((e) => {
  console.error('Não consegui carregar o banco; encerrando para não apagar dados:', e.message);
  process.exit(1);
});

function shutdown() {
  clearTimeout(persistTimer);
  doPersist().finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
