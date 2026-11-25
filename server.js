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
/* Admin: só as contas em ADMIN_NICKS (padrão: enaljack) + o código secreto abrem o painel.
   Dica: defina ADMIN_CODE e ADMIN_NICKS nas variáveis de ambiente do Render (o repositório é público). */
const ADMIN_NICKS = (process.env.ADMIN_NICKS || 'enaljack').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const ADMIN_CODE = String(process.env.ADMIN_CODE || 'Donodojogo');
/* Desenvolvedor: código DSVVDCP. Pode ver contas, banir/desbanir, expulsar, dar personagem e códigos, avisos e anotações.
   Só o DONO (Donodojogo) apaga contas, zera/edita stats e troca senhas. Quem pode usar: ADMIN_NICKS + DEV_NICKS. */
const DEV_CODE = String(process.env.DEV_CODE || 'DSVVDCP');
const DEV_NICKS = (process.env.DEV_NICKS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const GIVE_CODES = ['TURBO', 'TEMPO90', 'OURO', 'GELO'];
const ADMIN_MS = 60 * 60 * 1000;
const ONLINE_MS = 2 * 60 * 1000;
const normCode = (x) => String(x || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]/g, '');
const INDEX = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find((f) => fs.existsSync(f)) || path.join(__dirname, 'index.html');

let db = { users: {}, sessions: {}, log: [], broadcast: null, devs: [] };

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
    if (d && typeof d === 'object') db = { users: d.users || {}, sessions: d.sessions || {}, log: Array.isArray(d.log) ? d.log : [], broadcast: d.broadcast || null, devs: Array.isArray(d.devs) ? d.devs.filter((x) => typeof x === 'string') : [] };
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
function banOf(u) {
  const b = u && u.ban;
  if (!b) return null;
  if (b.until && b.until < Date.now()) { delete u.ban; persist(); return null; }
  return b;
}
function banMsg(b) {
  let quando = 'permanentemente';
  if (b.until) {
    try { quando = 'até ' + new Date(b.until).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }); }
    catch (e) { quando = 'até ' + new Date(b.until).toISOString(); }
  }
  return 'Conta banida ' + quando + (b.reason ? '. Motivo: ' + b.reason : '.');
}
function authed(req) {
  const m = /^Bearer (\S{20,100})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.sessions[sha(m[1])];
  if (!s || s.exp < Date.now() || !db.users[s.lk]) return null;
  const u = db.users[s.lk];
  const b = banOf(u);
  if (b) { req.banned = b; return null; }
  u.seen = Date.now();
  return { lk: s.lk, user: u, hash: sha(m[1]), sess: s };
}
function unauth(req, res) {
  if (req.banned) return send(res, 401, { error: banMsg(req.banned), banned: true });
  return send(res, 401, { error: 'Sessão expirada. Entre novamente.' });
}

/* ---------- painel de admin ---------- */
const isAdminLk = (lk) => ADMIN_NICKS.includes(lk);
const isDevLk = (lk) => DEV_NICKS.includes(lk) || db.devs.includes(lk);
function addLog(by, a, target, detail) {
  db.log.push({ t: Date.now(), by, a, target: target || '', detail: String(detail || '').slice(0, 160) });
  if (db.log.length > 300) db.log.splice(0, db.log.length - 300);
}
function dropSessions(lk) { for (const k of Object.keys(db.sessions)) if (db.sessions[k].lk === lk) delete db.sessions[k]; }
function safeEq(x, y) {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(x)).digest(), crypto.createHash('sha256').update(String(y)).digest());
}
function rowOf(u) {
  const t = (u.profile && u.profile.totals) || zeroTotals();
  return {
    nick: u.nick, created: u.created, seen: u.seen || 0,
    online: !!u.seen && Date.now() - u.seen < ONLINE_MS,
    games: t.games, points: t.points, wins: t.wins, best: (u.profile && u.profile.best) || 0,
    banned: !!banOf(u), owner: isAdminLk(u.nick.toLowerCase()), dev: isDevLk(u.nick.toLowerCase()),
  };
}
async function admin(req, res, pathname, ip) {
  const a = authed(req);
  if (!a || !(isAdminLk(a.lk) || isDevLk(a.lk))) return send(res, 404, { error: 'Não encontrado.' });
  const me = a.user.nick;

  if (pathname === '/api/admin/unlock' && req.method === 'POST') {
    const key = 'adm|' + a.lk + '|' + ip;
    if (limited(key, 6, 10 * 60e3, false)) return send(res, 429, { error: 'Muitas tentativas. Espere alguns minutos.' });
    const b = await readBody(req, 1024);
    const c = normCode(b.code);
    let role = null;
    if (isAdminLk(a.lk) && safeEq(c, normCode(ADMIN_CODE))) role = 'owner';
    else if (safeEq(c, normCode(DEV_CODE))) role = 'dev';
    if (!role) {
      limited(key, 6, 10 * 60e3, true);
      return send(res, 404, { error: 'Código inválido.' });
    }
    clearHits(key);
    a.sess.adm = Date.now() + ADMIN_MS;
    a.sess.role = role;
    addLog(me, 'login', '', role === 'owner' ? 'dono' : 'desenvolvedor');
    persist();
    return send(res, 200, { ok: true, exp: a.sess.adm, role, grant: isAdminLk(a.lk) });
  }
  if (!(a.sess.adm > Date.now())) return send(res, 403, { error: 'Painel trancado. Resgate o código de novo.', locked: true });
  a.sess.adm = Date.now() + ADMIN_MS; /* renova enquanto estiver usando */

  const url = new URL(req.url, 'http://x');
  const find = (nick) => {
    nick = String(nick || '').trim();
    const lk = nick.toLowerCase();
    return NICK_RE.test(nick) && db.users[lk] ? { lk, u: db.users[lk] } : null;
  };

  if (pathname === '/api/admin/lock' && req.method === 'POST') { a.sess.adm = 0; persist(); return send(res, 200, { ok: true }); }

  if (pathname === '/api/admin/stats' && req.method === 'GET') {
    const now = Date.now(), us = Object.values(db.users);
    let games = 0, points = 0;
    for (const u of us) { const t = (u.profile && u.profile.totals) || {}; games += t.games || 0; points += t.points || 0; }
    const top = us.map(rowOf).sort((x, y) => y.best - x.best).slice(0, 5).filter((r) => r.best > 0).map((r) => ({ nick: r.nick, best: r.best }));
    return send(res, 200, {
      total: us.length,
      online: us.filter((u) => u.seen && now - u.seen < ONLINE_MS).length,
      banned: us.filter((u) => banOf(u)).length,
      newToday: us.filter((u) => now - u.created < 864e5).length,
      new7: us.filter((u) => now - u.created < 7 * 864e5).length,
      games, points, top,
    });
  }

  if (pathname === '/api/admin/users' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase().trim().slice(0, 16);
    const sort = url.searchParams.get('sort') || 'recent';
    let rows = Object.values(db.users).filter((u) => !q || u.nick.toLowerCase().includes(q)).map(rowOf);
    if (sort === 'banned') rows = rows.filter((r) => r.banned);
    if (sort === 'points') rows.sort((x, y) => y.points - x.points);
    else if (sort === 'games') rows.sort((x, y) => y.games - x.games);
    else if (sort === 'new') rows.sort((x, y) => y.created - x.created);
    else rows.sort((x, y) => (y.online - x.online) || ((y.seen || y.created) - (x.seen || x.created)));
    return send(res, 200, { total: rows.length, users: rows.slice(0, 150) });
  }

  if (pathname === '/api/admin/user' && req.method === 'GET') {
    const f = find(url.searchParams.get('nick'));
    if (!f) return send(res, 404, { error: 'Conta não encontrada.' });
    const { lk, u } = f;
    const sessions = Object.values(db.sessions).filter((s) => s.lk === lk && s.exp > Date.now()).length;
    return send(res, 200, {
      nick: u.nick, created: u.created, seen: u.seen || 0, rev: u.rev, owner: isAdminLk(lk), dev: isDevLk(lk),
      online: !!u.seen && Date.now() - u.seen < ONLINE_MS,
      profile: u.profile, ban: banOf(u) || null, note: u.note || '', sessions,
    });
  }

  if (pathname === '/api/admin/devs' && req.method === 'GET') {
    if (!isAdminLk(a.lk)) return send(res, 403, { error: 'Só o dono vê quem é desenvolvedor.' });
    const all = [...new Set([...DEV_NICKS, ...db.devs])].filter((lk) => !isAdminLk(lk));
    return send(res, 200, { devs: all.map((lk) => {
      const u = db.users[lk];
      return { nick: u ? u.nick : lk, exists: !!u, env: DEV_NICKS.includes(lk), seen: u ? u.seen || 0 : 0 };
    }) });
  }
  if (pathname === '/api/admin/log' && req.method === 'GET') return send(res, 200, { log: db.log.slice(-120).reverse() });

  if (pathname === '/api/admin/broadcast' && req.method === 'GET') {
    const bc = db.broadcast && db.broadcast.exp > Date.now() ? db.broadcast : null;
    return send(res, 200, { bc });
  }

  if (req.method !== 'POST') return send(res, 404, { error: 'Não encontrado.' });
  const b = await readBody(req, 4096);

  if (pathname === '/api/admin/broadcast') {
    const text = String(b.text || '').trim().slice(0, 200);
    if (!text) { db.broadcast = null; addLog(me, 'bcclear', '', ''); persist(); return send(res, 200, { ok: true }); }
    const minutes = int(b.minutes, 1, 1440);
    db.broadcast = { id: crypto.randomBytes(4).toString('hex'), text, exp: Date.now() + minutes * 60e3, by: me, t: Date.now() };
    addLog(me, 'broadcast', '', text);
    persist();
    return send(res, 200, { ok: true });
  }

  const f = find(b.nick);
  if (!f) return send(res, 404, { error: 'Conta não encontrada.' });
  const { lk, u } = f;
  const action = pathname.slice('/api/admin/'.length);
  const owner = a.sess.role === 'owner';
  if (action === 'devgrant' || action === 'devrevoke') {
    if (!isAdminLk(a.lk)) return send(res, 403, { error: 'Só o dono pode conceder acesso de desenvolvedor.' });
    if (isAdminLk(lk)) return send(res, 400, { error: 'Essa conta já é de dono.' });
    if (action === 'devgrant') {
      if (isDevLk(lk)) return send(res, 400, { error: 'Essa conta já é desenvolvedora.' });
      db.devs.push(lk);
      addLog(me, 'devgrant', u.nick, '');
    } else {
      if (DEV_NICKS.includes(lk)) return send(res, 400, { error: 'Esse acesso vem do servidor (DEV_NICKS). Tire por lá.' });
      if (!db.devs.includes(lk)) return send(res, 400, { error: 'Essa conta não é desenvolvedora.' });
      db.devs = db.devs.filter((x) => x !== lk);
      for (const k of Object.keys(db.sessions)) if (db.sessions[k].lk === lk) { delete db.sessions[k].adm; delete db.sessions[k].role; }
      addLog(me, 'devrevoke', u.nick, '');
    }
    persist();
    return send(res, 200, { ok: true });
  }
  if (['delete', 'reset', 'edit', 'setpass'].includes(action) && !owner) return send(res, 403, { error: 'Só o dono pode fazer isso.' });
  if (isAdminLk(lk) && !((owner || lk === a.lk) && ['setpass', 'note', 'setchar', 'setcodes'].includes(action))) return send(res, 400, { error: 'Contas de dono são protegidas.' });
  if (isDevLk(lk) && !owner && lk !== a.lk && !['note'].includes(action)) return send(res, 400, { error: 'Só o dono mexe em contas de desenvolvedor.' });
  if (isDevLk(lk) && lk === a.lk && ['ban', 'unban', 'kick', 'delete'].includes(action)) return send(res, 400, { error: 'Você não pode fazer isso na sua própria conta.' });

  if (action === 'ban') {
    const hours = int(b.hours, 0, 24 * 365);
    u.ban = { reason: String(b.reason || '').trim().slice(0, 100), at: Date.now(), by: me, until: hours > 0 ? Date.now() + hours * 36e5 : null };
    addLog(me, 'ban', u.nick, (hours ? hours + ' h' : 'permanente') + (u.ban.reason ? ' · ' + u.ban.reason : ''));
  } else if (action === 'unban') {
    delete u.ban; addLog(me, 'unban', u.nick, '');
  } else if (action === 'kick') {
    dropSessions(lk); addLog(me, 'kick', u.nick, '');
  } else if (action === 'delete') {
    dropSessions(lk); delete db.users[lk]; db.devs = db.devs.filter((x) => x !== lk); addLog(me, 'delete', u.nick, '');
  } else if (action === 'reset') {
    u.profile = Object.assign(newProfile(), { char: u.profile.char }); u.rev++; dropSessions(lk);
    addLog(me, 'reset', u.nick, '');
  } else if (action === 'edit') {
    const t = u.profile.totals;
    if (b.best != null && b.best !== '') u.profile.best = int(b.best, 0, 100000);
    for (const k of ['games', 'points', 'wins', 'losses', 'ties']) if (b[k] != null && b[k] !== '') t[k] = int(b[k], 0, 10000000);
    u.rev++; dropSessions(lk);
    addLog(me, 'edit', u.nick, 'recorde ' + u.profile.best + ' · ' + t.games + ' partidas · ' + t.points + ' pts');
  } else if (action === 'setpass') {
    const pass = String(b.pass || '');
    if (pass.length < 4 || pass.length > 64) return send(res, 400, { error: 'A senha precisa ter de 4 a 64 caracteres.' });
    const salt = crypto.randomBytes(16);
    u.salt = salt.toString('hex'); u.hash = (await scrypt(pass, salt)).toString('hex');
    if (lk !== a.lk) dropSessions(lk);
    addLog(me, 'setpass', u.nick, '');
  } else if (action === 'setchar') {
    const ch = String(b.char || '');
    if (!/^[a-z0-9_-]{1,24}$/.test(ch)) return send(res, 400, { error: 'Personagem inválido.' });
    u.profile.char = ch; u.rev++;
    addLog(me, 'setchar', u.nick, ch);
  } else if (action === 'setcodes') {
    const list = Array.isArray(b.codes) ? [...new Set(b.codes.map(String))] : [];
    if (list.some((c) => !GIVE_CODES.includes(c))) return send(res, 400, { error: 'Código inválido na lista.' });
    if (list.includes('OURO') && list.includes('GELO')) return send(res, 400, { error: 'Escolha só uma cor: OURO ou GELO.' });
    u.profile.codes = list; u.rev++;
    addLog(me, 'setcodes', u.nick, list.join(', ') || 'nenhum');
  } else if (action === 'note') {
    u.note = String(b.note || '').slice(0, 300);
    addLog(me, 'note', u.nick, u.note.slice(0, 60));
  } else {
    return send(res, 404, { error: 'Não encontrado.' });
  }
  persist();
  return send(res, 200, { ok: true });
}

/* ---------- salas online (Passe) ---------- */
/* Salas ficam só na memória do servidor (somem se ele reiniciar). Cada jogador manda a própria posição ~5x/s e recebe a dos outros. */
const ROOM_MAX = 6, ROOM_DROP = 40e3, ROOM_SEEN = 12e3, BLOCK_R = 3.8, BLOCK_CD = 1500;
const ROOM_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map(), roomOf = new Map();
const normRoom = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
function newRoomCode() {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let k = 0; k < 5; k++) c += ROOM_ALPHA[crypto.randomInt(ROOM_ALPHA.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function roomLeave(lk) {
  const code = roomOf.get(lk);
  roomOf.delete(lk);
  const r = code && rooms.get(code);
  if (!r) return;
  const m = r.members.get(lk);
  r.members.delete(lk);
  ballGone(r, lk, m);
  if (!r.members.size) rooms.delete(code);
}
/* Bola única da sala: quem segura (holder) e quem simula a física quando está solta (owner). */
function newBall(holder) { return { x: 0, y: 0.12, z: 0, vx: 0, vy: 0, vz: 0, holder, owner: holder, seq: 0 }; }
function ballGone(r, lk, m) {
  const b = r.ball;
  if (!b) return;
  if (b.holder === lk) { b.x = m ? m.x : 0; b.y = 0.12; b.z = m ? m.z : 0; b.vx = b.vy = b.vz = 0; b.holder = null; b.seq++; }
  if (b.owner === lk) b.owner = b.holder || r.members.keys().next().value || null;
}
function ballFix(r, self) {
  const b = r.ball, now = Date.now();
  if (!b) return;
  const hm = b.holder && r.members.get(b.holder);
  if (b.holder && (!hm || (now - hm.t > ROOM_SEEN && b.holder !== self))) {
    if (hm) { b.x = hm.x; b.z = hm.z; }
    b.y = 0.12; b.vx = b.vy = b.vz = 0; b.holder = null; b.seq++; b.owner = self;
  }
  const om = r.members.get(b.owner);
  if (!b.holder && (!om || (now - om.t > ROOM_SEEN && b.owner !== self))) b.owner = self;
}
function ballOut(r, self) {
  const b = r.ball;
  if (!b) return null;
  const hm = b.holder && r.members.get(b.holder);
  return { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, seq: b.seq, h: hm ? hm.nick : null, hy: b.holder === self, oy: b.owner === self,
    k: b.blk && Date.now() - b.blk.t < 2000 ? b.blk.by : null, ki: b.blk ? b.blk.t : 0 };
}
function roomJoin(r, lk, nick) {
  if (roomOf.get(lk) && roomOf.get(lk) !== r.code) roomLeave(lk);
  r.members.set(lk, { nick, char: 'fogueteiro', score: 0, x: 0, z: 0, y: 0, yaw: 0, t: Date.now() });
  roomOf.set(lk, r.code);
}
function roomPrune(r) {
  const now = Date.now();
  for (const [lk, m] of r.members) if (now - m.t > ROOM_DROP) { r.members.delete(lk); ballGone(r, lk, m); if (roomOf.get(lk) === r.code) roomOf.delete(lk); }
}
function roomPlayers(r, self) {
  const now = Date.now(), out = [];
  for (const [lk, m] of r.members) {
    if (now - m.t > ROOM_SEEN && lk !== self) continue;
    out.push({ nick: m.nick, char: m.char, score: m.score, a: m.a || 0, x: m.x, z: m.z, y: m.y, yaw: m.yaw, you: lk === self });
  }
  return out;
}
setInterval(() => {
  for (const [c, r] of rooms) { roomPrune(r); if (!r.members.size) rooms.delete(c); }
}, 30 * 1000).unref();

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
      const bn = banOf(u);
      if (bn) return send(res, 403, { error: banMsg(bn), banned: true });
      u.seen = Date.now();
      const token = newSession(lk);
      persist();
      return send(res, 200, { token, nick: u.nick, profile: pub(u) });
    }
    if (pathname === '/api/profile' && (req.method === 'GET' || req.method === 'PUT')) {
      const a = authed(req);
      if (!a) return unauth(req, res);
      if (req.method === 'GET') return send(res, 200, { nick: a.user.nick, profile: pub(a.user) });
      const b = await readBody(req, 16384);
      if (Number(b.rev) !== a.user.rev) return send(res, 409, { error: 'Dados mais novos no servidor.', profile: pub(a.user) });
      a.user.profile = cleanProfile(b);
      a.user.rev++;
      persist();
      return send(res, 200, { rev: a.user.rev });
    }
    if (pathname === '/api/ping' && req.method === 'GET') {
      const a = authed(req);
      if (!a) return unauth(req, res);
      const bc = db.broadcast && db.broadcast.exp > Date.now() ? { id: db.broadcast.id, text: db.broadcast.text } : null;
      return send(res, 200, { bc, rev: a.user.rev });
    }
    if (pathname === '/api/leaderboard' && req.method === 'GET') {
      const a = authed(req);
      if (!a) return unauth(req, res);
      const rows = Object.values(db.users)
        .filter((u) => u.profile && u.profile.totals && u.profile.totals.wins > 0 && !banOf(u))
        .map((u) => ({ nick: u.nick, wins: u.profile.totals.wins, games: u.profile.totals.games, char: u.profile.char }))
        .sort((x, y) => y.wins - x.wins || x.games - y.games || x.nick.localeCompare(y.nick))
        .slice(0, 20);
      return send(res, 200, { rows });
    }
    if (pathname.startsWith('/api/room/') && req.method === 'POST') {
      const a = authed(req);
      if (!a) return unauth(req, res);
      const act = pathname.slice('/api/room/'.length);
      const b = await readBody(req, 2048);
      if (act === 'create') {
        if (limited('roomc|' + a.lk, 10, 60e3, true)) return send(res, 429, { error: 'Muitas salas criadas. Espere um pouco.' });
        roomLeave(a.lk);
        const code = newRoomCode();
        if (!code) return send(res, 503, { error: 'Não foi possível criar a sala agora.' });
        const r = { code, host: a.lk, created: Date.now(), members: new Map(), ball: newBall(a.lk) };
        rooms.set(code, r);
        roomJoin(r, a.lk, a.user.nick);
        return send(res, 200, { code });
      }
      if (act === 'join') {
        if (limited('roomj|' + ip, 30, 60e3, true)) return send(res, 429, { error: 'Muitas tentativas. Espere um pouco.' });
        const code = normRoom(b.code);
        const r = code ? rooms.get(code) : null;
        if (!r) return send(res, 404, { error: 'Sala não encontrada. Confira o código.' });
        roomPrune(r);
        if (!r.members.has(a.lk) && r.members.size >= ROOM_MAX) return send(res, 409, { error: 'Essa sala está cheia.' });
        roomJoin(r, a.lk, a.user.nick);
        return send(res, 200, { code, players: roomPlayers(r, a.lk) });
      }
      if (act === 'sync') {
        const r = rooms.get(roomOf.get(a.lk) || '') || rooms.get(normRoom(b.code));
        if (!r) return send(res, 404, { error: 'A sala foi encerrada.', gone: true });
        let m = r.members.get(a.lk);
        if (!m) {
          roomPrune(r);
          if (r.members.size >= ROOM_MAX) return send(res, 404, { error: 'A sala foi encerrada.', gone: true });
          roomJoin(r, a.lk, a.user.nick);
          m = r.members.get(a.lk);
        }
        m.x = flt(b.x, -30, 30, m.x); m.z = flt(b.z, -30, 30, m.z);
        m.y = flt(b.y, 0, 4, 0); m.yaw = flt(b.yaw, -1000, 1000, m.yaw);
        m.char = typeof b.char === 'string' && /^[a-z0-9_-]{1,24}$/.test(b.char) ? b.char : m.char;
        m.score = int(b.score, 0, 100000);
        m.a = int(b.a, 0, 6);
        m.t = Date.now();
        const bl = r.ball;
        if (bl) {
          ballFix(r, a.lk);
          if (b.bk === 1) {
            /* bloqueio: vale contra quem está mirando (segurando a bola, estado 2) ou enterrando (estado 5), a até BLOCK_R */
            const now = Date.now(), tgt = bl.holder || bl.owner, tm = tgt && tgt !== a.lk ? r.members.get(tgt) : null;
            if (tm && now - tm.t < ROOM_SEEN && now - (m.bkAt || 0) > BLOCK_CD
              && ((bl.holder && tm.a === 2) || (!bl.holder && tm.a === 5))
              && Math.hypot(tm.x - m.x, tm.z - m.z) < BLOCK_R) {
              let dx = m.x - tm.x, dz = m.z - tm.z;
              const dl = Math.hypot(dx, dz) || 1;
              dx /= dl; dz /= dl;
              if (bl.holder) { bl.x = tm.x; bl.y = 2.3; bl.z = tm.z; }
              bl.vx = dx * 6; bl.vy = 3; bl.vz = dz * 6;
              bl.holder = null; bl.owner = a.lk; bl.seq++;
              bl.blk = { by: m.nick, from: tgt, t: now };
              m.bkAt = now;
            }
          }
          if (b.bs === 1 && bl.holder && bl.holder !== a.lk) {
            /* roubo: precisa estar perto de quem segura (Ser Perfeito rouba de qualquer lugar) */
            const hm = r.members.get(bl.holder);
            if (m.char === 'serperfeito' || (hm && Math.hypot(hm.x - m.x, hm.z - m.z) < 3.5)) { bl.holder = a.lk; bl.owner = a.lk; bl.seq++; }
          } else if (b.bg === 1 && !bl.holder && !(bl.blk && bl.blk.from === a.lk && Date.now() - bl.blk.t < 900) && (bl.owner === a.lk || Math.hypot(bl.x - m.x, bl.z - m.z) < 4.5)) {
            bl.holder = a.lk; bl.owner = a.lk; bl.seq++;
          }
          if (b.bf === 1 && (bl.holder === a.lk || (!bl.holder && bl.owner === a.lk))) {
            bl.holder = null; bl.owner = a.lk;
            bl.x = flt(b.bx, -14, 14, bl.x); bl.y = flt(b.by, 0, 12, bl.y); bl.z = flt(b.bz, -22, 22, bl.z);
            bl.vx = flt(b.bvx, -40, 40, 0); bl.vy = flt(b.bvy, -40, 40, 0); bl.vz = flt(b.bvz, -40, 40, 0);
            bl.seq++;
          }
          if (b.bd === 1 && !bl.holder && bl.owner === a.lk) {
            for (const [k, o] of r.members) if (k !== a.lk && Date.now() - o.t < ROOM_SEEN) { bl.owner = k; break; }
          }
        }
        return send(res, 200, { code: r.code, players: roomPlayers(r, a.lk), ball: ballOut(r, a.lk) });
      }
      if (act === 'leave') { roomLeave(a.lk); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'Não encontrado.' });
    }
    if (pathname.startsWith('/api/admin/')) return admin(req, res, pathname, ip);
    if (pathname === '/api/logout' && req.method === 'POST') {
      const a = authed(req);
      if (a) { delete db.sessions[a.hash]; roomLeave(a.lk); persist(); }
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
