const Media = (() => {
  const KEY = 'jaki3_media_cfg';
  const DEF = { auto: true, confirm: false, provider: '', model: 'MiniMax-Hailuo-2.3', resolution: '768P' };
  const POLL_MS = 5000;               // jeda cek status task video
  const MAX_WAIT_MS = 12 * 60 * 1000; // batas tunggu satu video
  // Penyaring murah: router (1 panggilan model) hanya dijalankan jika pesan mengandung salah satu kata ini.
  const MEDIA_RE = /\b(video|vidio|klip|clip|footage|animasi|animation|animated|animate|motion|bergerak|gif|reel|intro|outro|logo reveal|lower third|sinematik|cinematic|loading screen)\b/i;

  const ROUTER_SYS = [
    'Kamu adalah router untuk asisten Jaki. Tentukan cara terbaik memenuhi pesan user terakhir. Pilih satu mode:',
    '- "chat": pertanyaan, penjelasan, kode biasa, atau apa pun yang bukan permintaan membuat video/animasi.',
    '- "video": user ingin klip video sinematik hasil generasi AI (adegan, orang, alam, produk, gerakan kamera, footage realistis atau artistik).',
    '- "animation": user ingin motion graphic atau animasi desain: teks bergerak, logo reveal, infografik atau grafik bergerak, intro/outro, loading animation, diagram beranimasi, animasi UI. Dibuat sebagai kode HTML/CSS/SVG.',
    '',
    'Aturan:',
    '- Jika user bertanya TENTANG video atau animasi (bukan meminta dibuatkan), pilih "chat".',
    '- Jika ada teks, angka, atau logo yang harus tampil tepat dan terbaca, pilih "animation".',
    '- Jika ragu antara "video" dan "animation", pilih "animation".',
    '- Jika "MODE SUDAH DITENTUKAN USER" ada, pakai mode itu.',
    '- Jika mode "video", isi "video_prompt": deskripsi adegan dalam bahasa Inggris, maksimal 800 karakter (subjek, aksi, setting, gaya, pencahayaan). Boleh menyisipkan perintah kamera dalam kurung siku seperti [Pan left], [Pedestal up], atau [Static shot]. Isi "duration" dengan 6 atau 10 (detik).',
    '',
    'Balas HANYA dengan satu objek JSON valid, tanpa teks lain:',
    '{"mode":"chat|video|animation","reason":"alasan singkat","video_prompt":"","duration":6}',
  ].join('\n');

  // Ditambahkan ke system prompt chat biasa saat jalur animation dipilih.
  const ANIM_PROMPT = [
    '<mode_animasi>',
    'User meminta motion graphic atau animasi. Jawab dengan SATU file HTML lengkap dan mandiri di dalam satu blok kode ```html (CSS, SVG, dan JS berada di file yang sama).',
    'Aturan:',
    '- Jangan memakai library, font, gambar, atau skrip dari internet; semua akses jaringan diblokir di pratinjau.',
    '- Pakai CSS animation, SVG, canvas, atau requestAnimationFrame.',
    '- Layout responsif mengisi area (width 100%, height 100vh, margin 0) dengan latar yang jelas dan teks yang terbaca.',
    '- Animasi mulai otomatis dan berulang (loop), atau berakhir dengan rapi.',
    '- Tulis maksimal 2 kalimat deskripsi sebelum kode, dan 1-2 kalimat setelah kode tentang cara mengubah warna atau durasi.',
    '- Jangan membuat lebih dari satu blok html.',
    '</mode_animasi>',
  ].join('\n');

  function getCfg() {
    let r = {};
    try { r = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { r = {}; }
    return { ...DEF, ...r };
  }
  function setCfg(c) {
    try { localStorage.setItem(KEY, JSON.stringify({ ...getCfg(), ...c })); return true; } catch { return false; }
  }

  const abortErr = () => new DOMException('Dibatalkan oleh pengguna.', 'AbortError');
  const sleep = (ms, signal) => new Promise((ok, no) => {
    if (signal.aborted) return no(abortErr());
    const t = setTimeout(ok, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); no(abortErr()); }, { once: true });
  });
  function parseJson(text) {
    const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
  }
  // buildBody dipakai ulang apa adanya, system prompt diganti milik router.
  function withSystem(b, p, sys) {
    if (p.type === 'anthropic') b.system = sys; else b.messages[0] = { role: 'system', content: sys };
    return b;
  }

  function command(t) {
    let m;
    if ((m = t.match(/^\/chat\b\s*([\s\S]*)/i))) return { mode: 'chat', text: m[1].trim() };
    if ((m = t.match(/^\/(?:video|vid)\b\s+([\s\S]+)/i))) return { mode: 'video', text: m[1].trim() };
    if ((m = t.match(/^\/(?:animasi|anim|motion)\b\s+([\s\S]+)/i))) return { mode: 'animation', text: m[1].trim() };
    return null;
  }
  const looksMedia = t => MEDIA_RE.test(String(t || ''));

  async function chatOnce(p, body, signal) {
    const am = { text: '', think: '' };
    let r;
    try {
      r = await relay(p, chatUrl(p), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw abortErr();
      throw new Error(`Tidak bisa terhubung ke proxy (${cfg.proxy}). Jalankan "node proxy.js" lalu coba lagi.`);
    }
    try {
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}${hint(r.status)}`);
      if ((r.headers.get('content-type') || '').includes('event-stream')) await readSSE(r, p.type, am, () => {});
      else parseFull(await r.json(), p.type, am);
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw abortErr();
      throw e;
    }
    return am;
  }

  // Hasil: { mode: 'chat'|'video'|'animation', reason, prompt?, duration? }
  async function route(p, msgs, signal, force, text) {
    const last = msgs[msgs.length - 1];
    const ask = String(text || (last && last.text) || '').trim().slice(0, 1500);
    const ctx = msgs.slice(-3, -1).map(m => `${m.role === 'user' ? 'User' : 'Asisten'}: ${(m.text || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    const input = (ctx ? `KONTEKS SEBELUMNYA:\n${ctx}\n\n` : '') + (force ? `MODE SUDAH DITENTUKAN USER: ${force}\n\n` : '') + `PESAN USER TERAKHIR:\n${ask}`;
    const am = await chatOnce(p, withSystem(buildBody(p, [{ role: 'user', text: input, atts: [] }], false, 700), p, ROUTER_SYS), signal);
    const j = parseJson(am.text);
    if (!j && !force) throw new Error('Router tidak menghasilkan JSON yang valid.');
    const mode = force || (['chat', 'video', 'animation'].includes(j.mode) ? j.mode : 'chat');
    const out = { mode, reason: String((j && j.reason) || '') };
    if (mode === 'video') {
      out.prompt = (String((j && j.video_prompt) || '').trim() || ask).slice(0, 2000);
      out.duration = j && Number(j.duration) === 10 ? 10 : 6;
    }
    return out;
  }

  /* ---------- Video MiniMax (asinkron: buat task, cek status, ambil file) ---------- */
  function videoProvider() {
    const c = getCfg();
    const p = provs.find(x => x.id === c.provider) || provs.find(x => /minimax/i.test((x.url || '') + ' ' + (x.name || '')));
    if (!p) throw new Error('Provider MiniMax belum ada. Tambahkan di "API & Model" (Base URL https://api.minimax.io/v1 dan API key MiniMax), lalu pilih di dialog Media.');
    if (!p.key) throw new Error(`API key provider "${p.name}" masih kosong. Isi dulu di "API & Model".`);
    return { ...p, type: 'openai' }; // endpoint video memakai Bearer; relay() memberi header itu untuk tipe openai
  }
  const originOf = p => { try { return new URL(p.url).origin; } catch { throw new Error(`Base URL provider "${p.name}" tidak valid.`); } };

  async function api(vp, url, init, signal) {
    let r;
    try {
      r = await relay(vp, url, { ...init, signal, headers: init.body ? { 'content-type': 'application/json' } : {} });
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw abortErr();
      throw new Error(`Tidak bisa terhubung ke proxy (${cfg.proxy}). Jalankan "node proxy.js" lalu coba lagi.`);
    }
    let raw;
    try { raw = await r.text(); } catch (e) { throw signal.aborted ? abortErr() : e; }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw.slice(0, 300)}${hint(r.status)}`);
    let d;
    try { d = JSON.parse(raw); } catch { throw new Error('Respons MiniMax bukan JSON yang valid.'); }
    const br = d.base_resp;
    if (br && br.status_code) throw new Error(`MiniMax: ${br.status_msg || 'error'} (kode ${br.status_code})`);
    return d;
  }

  async function fileUrl(vp, origin, fileId, signal) {
    const d = await api(vp, `${origin}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {}, signal);
    let u = String((d.file && d.file.download_url) || '').trim();
    if (!u) throw new Error('MiniMax tidak mengembalikan download_url untuk video ini.');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    return u;
  }
  // Tautan unduhan bisa kedaluwarsa; ambil yang baru berdasarkan file_id.
  function refreshUrl(fileId) {
    const vp = videoProvider();
    return fileUrl(vp, originOf(vp), fileId, AbortSignal.timeout(20000));
  }

  const STATUS_ID = { preparing: 'Menyiapkan', queueing: 'Mengantre', processing: 'Memproses' };
  async function video({ prompt, duration, signal, onNote, pollMs, maxWaitMs }) {
    const note = t => { if (onNote) onNote(t); };
    const c = getCfg(), vp = videoProvider(), origin = originOf(vp);
    const dur = Number(duration) === 10 ? 10 : 6;
    const res = dur === 10 && c.resolution === '1080P' ? '768P' : c.resolution; // 10 detik tidak mendukung 1080P
    const model = c.model || DEF.model;
    const text = String(prompt || '').trim().slice(0, 2000);
    if (!text) throw new Error('Prompt video kosong.');

    note('Mengirim permintaan ke MiniMax…');
    const made = await api(vp, `${origin}/v1/video_generation`, { method: 'POST', body: JSON.stringify({ model, prompt: text, duration: dur, resolution: res }) }, signal);
    const id = made.task_id;
    if (!id) throw new Error('MiniMax tidak mengembalikan task_id.');

    const t0 = Date.now();
    let fileId = '';
    for (;;) {
      await sleep(pollMs || POLL_MS, signal);
      const q = await api(vp, `${origin}/v1/query/video_generation?task_id=${encodeURIComponent(id)}`, {}, signal);
      const st = String(q.status || '');
      if (/^success/i.test(st)) { fileId = q.file_id; break; }
      if (/^fail/i.test(st)) throw new Error('Video gagal dibuat oleh MiniMax' + (q.base_resp && q.base_resp.status_msg ? ': ' + q.base_resp.status_msg : '.'));
      const ms = Date.now() - t0;
      if (ms > (maxWaitMs || MAX_WAIT_MS)) throw new Error(`Video belum selesai setelah ${Math.round(ms / 60000)} menit. Task ${id} mungkin masih diproses di MiniMax.`);
      note(`${STATUS_ID[st.toLowerCase()] || 'Memproses'}… ${Math.round(ms / 1000)} dtk`);
    }
    if (!fileId) throw new Error('Video selesai tetapi MiniMax tidak mengembalikan file_id.');
    note('Mengambil tautan video…');
    const url = await fileUrl(vp, origin, fileId, signal);
    return { task_id: String(id), file_id: String(fileId), url, model, duration: dur, resolution: res, prompt: text };
  }

  return { getCfg, setCfg, command, looksMedia, route, video, refreshUrl, ANIM_PROMPT };
})();