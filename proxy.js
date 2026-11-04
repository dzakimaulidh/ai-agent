// Proxy universal + memori lokal untuk Jaki Agent.
// Jalankan: node proxy.js
// - Relay: halaman mengirim tujuan lewat header x-target-url / x-target-key / x-target-auth.
// - Memori: disimpan di SQLite lokal (jaki-memory.db, sebelah file ini) lewat endpoint /mem/*.
//   Butuh Node 22.13+ (node:sqlite bawaan), atau Node 18+ dengan: npm i better-sqlite3
//
// Variabel lingkungan (opsional):
//   JAKI_HOST         alamat bind. Default 127.0.0.1 (hanya komputer ini). Isi 0.0.0.0 agar HP/laptop lain di Wi-Fi yang sama bisa akses.
//   JAKI_PORT         port. Default 3001.
//   JAKI_DB           lokasi file database memori. Default jaki-memory.db di sebelah file ini.
//   JAKI_ORIGINS      origin halaman tambahan yang diizinkan, pisahkan dengan koma. Contoh: http://pc-saya.local:5500
//   JAKI_ALLOW_NULL   isi 1 jika halaman dibuka langsung dari file:// (origin "null"). Default ditolak karena bisa disalahgunakan situs lain.
const http = require('http');
const path = require('path');

const PORT = Number(process.env.JAKI_PORT) || 3001;
const HOST = process.env.JAKI_HOST || '127.0.0.1';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const DB_FILE = process.env.JAKI_DB || path.join(__dirname, 'jaki-memory.db');
const MAX_TEXT = 300;      // panjang maksimal satu ingatan
const MAX_ROWS = 500;      // batas total ingatan
const MAX_BODY = 150e6;    // batas ukuran request relay (lampiran gambar/PDF base64 bisa besar)
const CATS = ['profil', 'proyek', 'preferensi', 'fakta'];
const STOP = new Set('yang dan di ke dari untuk dengan ini itu aku saya kamu bisa apa gak ga nggak tidak mau the and for you how'.split(' '));

// Origin yang boleh memakai proxy: localhost + IP jaringan lokal (LAN). Origin internet/publik ditolak.
// "null" (file://) sengaja tidak diizinkan kecuali JAKI_ALLOW_NULL=1.
const ORIGIN_OK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(:\d+)?$/;
const EXTRA_ORIGINS = (process.env.JAKI_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_NULL = process.env.JAKI_ALLOW_NULL === '1';
const originOk = o => ORIGIN_OK.test(o) || EXTRA_ORIGINS.includes(o) || (o === 'null' && ALLOW_NULL);

// Penjaga dasar untuk tujuan relay: blokir alamat metadata cloud dan link-local.
// localhost dan IP LAN sengaja tetap boleh karena dipakai Ollama / LM Studio.
function blockedTarget(u) {
  let h;
  try { h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return 'x-target-url tidak valid'; }
  if (/^169\.254\./.test(h) || /^fe80:/.test(h) || h === 'metadata.google.internal' || h === '0.0.0.0')
    return 'tujuan diblokir (alamat metadata atau link-local)';
  return '';
}

// Pola rahasia yang tidak boleh masuk memori (key, token, password, nomor kartu atau KTP).
// Bisa ada false positive; itu disengaja (lebih baik kelewat hati-hati).
const SECRET_RE = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(?:password|passwd|pwd|kata\s*sandi|sandi|api[\s_-]?key|secret|token)\b[^.\n]{0,20}?(?:[:=]|\badalah\b|\bis\b)\s*\S{4,}/i,
  /(?:\d[ -]?){15,19}/,
  /[A-Za-z0-9+/_-]{40,}={0,2}/,
];
const isSecret = t => SECRET_RE.some(re => re.test(t));

/* ---------- Database ---------- */
function openDb(file) {
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(file); }
  catch {
    try { const Database = require('better-sqlite3'); return new Database(file); }
    catch { return null; }
  }
}
const db = openDb(DB_FILE);
let hasFts = false;
if (db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memories(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    cat TEXT NOT NULL DEFAULT 'fakta',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(text, content='memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
        INSERT INTO mem_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON memories BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO mem_fts(rowid, text) VALUES (new.id, new.text);
      END;`);
    hasFts = true;
  } catch { /* FTS5 tidak ada: pakai LIKE */ }
  console.log('Memori: ' + DB_FILE + (hasFts ? ' (FTS5)' : ' (LIKE)'));
} else {
  console.log('Memori nonaktif: SQLite tidak tersedia (pakai Node 22.13+ atau npm i better-sqlite3). Relay tetap jalan.');
}

/* ---------- Logika memori ---------- */
const now = () => Date.now();
const clean = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const tokens = q => [...new Set((String(q || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(t => !STOP.has(t)))].slice(0, 12);

function search(q, limit) {
  const tk = tokens(q);
  if (!tk.length) return [];
  if (hasFts) {
    try {
      return db.prepare('SELECT m.* FROM mem_fts f JOIN memories m ON m.id = f.rowid WHERE mem_fts MATCH ? ORDER BY bm25(mem_fts) LIMIT ?')
        .all(tk.map(t => `"${t}"*`).join(' OR '), limit);
    } catch { /* jatuh ke LIKE */ }
  }
  const where = tk.map(() => 'text LIKE ?').join(' OR ');
  return db.prepare(`SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC LIMIT ?`).all(...tk.map(t => `%${t}%`), limit);
}

// Ingatan inti (profil & preferensi) selalu ikut, sisanya dicari yang paling relevan.
function recall(q, limit = 6) {
  const always = db.prepare("SELECT * FROM memories WHERE cat IN ('profil','preferensi') ORDER BY updated_at DESC LIMIT 8").all();
  const seen = new Set(always.map(m => m.id));
  return [...always, ...search(q, limit).filter(m => !seen.has(m.id))];
}

function apply(ops) {
  const r = { added: 0, updated: 0, deleted: 0, blocked: 0 };
  db.exec('BEGIN');
  try {
    for (const o of (Array.isArray(ops) ? ops : []).slice(0, 8)) {
      const t = clean(o.text), cat = CATS.includes(o.cat) ? o.cat : null, t0 = now();
      if ((o.op === 'add' || o.op === 'update') && t && isSecret(t)) { r.blocked++; continue; } // jangan simpan rahasia
      if (o.op === 'add' && t) {
        if (db.prepare('SELECT 1 FROM memories WHERE lower(text) = lower(?)').get(t)) continue;
        if (db.prepare('SELECT COUNT(*) AS n FROM memories').get().n >= MAX_ROWS) continue;
        db.prepare('INSERT INTO memories(text, cat, created_at, updated_at) VALUES (?,?,?,?)').run(t, cat || 'fakta', t0, t0);
        r.added++;
      } else if (o.op === 'update' && t && Number.isInteger(o.id)) {
        r.updated += Number(db.prepare('UPDATE memories SET text = ?, cat = COALESCE(?, cat), updated_at = ? WHERE id = ?').run(t, cat, t0, o.id).changes);
      } else if (o.op === 'delete' && Number.isInteger(o.id)) {
        r.deleted += Number(db.prepare('DELETE FROM memories WHERE id = ?').run(o.id).changes);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return r;
}

/* ---------- HTTP ---------- */
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
async function readBody(req, max = Infinity) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Error('body terlalu besar'); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function handleMem(req, res) {
  if (!db) return json(res, 503, { error: 'SQLite tidak tersedia. Pakai Node 22.13+ atau jalankan: npm i better-sqlite3' });
  const route = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && route === '/mem/list')
      return json(res, 200, { items: db.prepare('SELECT * FROM memories ORDER BY cat, updated_at DESC').all() });
    if (req.method !== 'POST') return json(res, 405, { error: 'method tidak didukung' });
    const raw = await readBody(req, 1e6);
    const b = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    if (route === '/mem/search') return json(res, 200, { items: recall(b.query, Math.min(+b.limit || 6, 12)) });
    if (route === '/mem/apply') return json(res, 200, apply(b.ops));
    if (route === '/mem/clear') { db.exec('DELETE FROM memories'); return json(res, 200, { ok: true }); }
    json(res, 404, { error: 'route tidak ada' });
  } catch (e) { json(res, 500, { error: e.message }); }
}

const warned = new Set();
async function handle(req, res) {
  // Cek origin untuk SEMUA route (relay dan memori). Browser selalu mengirim Origin pada request lintas situs,
  // jadi situs lain di browser lo tidak bisa memakai proxy ini. Request tanpa Origin (curl, skrip lokal) tetap lolos.
  const origin = req.headers.origin;
  if (origin) {
    if (!originOk(origin)) {
      if (!warned.has(origin)) { warned.add(origin); console.log(`Ditolak: origin ${origin}. Jika ini halaman Jaki lo, jalankan dengan JAKI_ORIGINS=${origin}`); }
      return json(res, 403, { error: 'origin tidak diizinkan' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, anthropic-version, x-target-url, x-target-key, x-target-auth');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url === '/ping') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (req.url.startsWith('/mem/')) return handleMem(req, res);

  const target = req.headers['x-target-url'];
  if (!target || !/^https?:\/\//i.test(target)) return json(res, 400, { error: 'header x-target-url tidak ada atau salah' });
  const why = blockedTarget(target);
  if (why) return json(res, 403, { error: why });

  let body;
  try { body = await readBody(req, MAX_BODY); }
  catch (e) { return json(res, 413, { error: e.message }); }
  const headers = { accept: req.headers.accept || '*/*' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
  const key = req.headers['x-target-key'];
  if (key) {
    if (req.headers['x-target-auth'] === 'x-api-key') headers['x-api-key'] = key;
    else headers['authorization'] = 'Bearer ' + key;
  }

  const ac = new AbortController();
  res.on('close', () => ac.abort()); // tombol Stop di halaman ikut menghentikan request upstream

  try {
    const r = await fetch(target, { method: req.method, headers, body: req.method === 'GET' ? undefined : body, signal: ac.signal });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache' });
    for await (const chunk of r.body) res.write(chunk); // stream apa adanya
    res.end();
  } catch (e) {
    if (res.headersSent) return res.end();
    json(res, 502, { error: 'Proxy gagal menghubungi upstream: ' + e.message });
  }
}

// Satu error di satu request tidak boleh mematikan seluruh proxy.
http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); else res.end(); }
}).listen(PORT, HOST, () => {
  console.log(`Proxy jalan di http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}` + (LOOPBACK ? ' (hanya komputer ini)' : ' (terbuka untuk jaringan lokal)'));
  if (!LOOPBACK) console.log('PERHATIAN: proxy terbuka di jaringan lokal. Pakai hanya di jaringan yang lo percaya.');
});
process.on('unhandledRejection', e => console.log('Error tak tertangani:', e && e.message ? e.message : e));