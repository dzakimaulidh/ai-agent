/* orchestra.js: sistem multi-agent & multi-model untuk Jaki.
   Dimuat SETELAH script utama dan memory.js di minimax_ai_agent_webview.html.
   Memakai ulang fungsi/variabel script utama: relay, chatUrl, buildBody, parseFull, readSSE, hint, provs, cfg.
   Isi file ini: konfigurasi, Supervisor, scheduler, worker, Writer, dan penyimpanan hasil (am.orchestra).
   UI (mode, dialog Kelola Orkestra, progress) ada di HTML. */


const Orchestra = (() => {
  const KEY = 'jaki3_orchestra_cfg';
  const ORDER = ['supervisor', 'analyst', 'coder', 'writer'];
  const WORKERS = ['analyst', 'coder'];
  const LABELS = { supervisor: 'Supervisor', analyst: 'Analyst', coder: 'Coder', writer: 'Writer' };
  const DESC = {
    supervisor: 'Memahami permintaan dan menyusun rencana kerja (keluaran harus JSON).',
    analyst: 'Menganalisis konteks, memecah masalah, membandingkan pilihan, memberi rekomendasi.',
    coder: 'Menulis, memperbaiki, meninjau, dan menjelaskan kode.',
    writer: 'Aggregator dan verifier: menggabungkan semua hasil menjadi jawaban akhir.',
  };
  const ROLE = {
    analyst: 'menganalisis konteks, memecah masalah, membandingkan pilihan, dan membuat rekomendasi (tidak punya akses web)',
    coder: 'menulis, memperbaiki, meninjau, dan menjelaskan kode',
  };
  const HIST = 6;       // jumlah pesan riwayat sebelum pesan user terakhir yang dikirim ke setiap agent
  const MAX_TASKS = 8;  // batas task dari Supervisor

  const PROMPTS = {
    supervisor: [
      'Kamu adalah Supervisor dalam sistem multi-agent Jaki. Tugasmu HANYA memahami permintaan user dan menyusun rencana kerja dalam bentuk JSON. Kamu tidak menjawab pertanyaan user dan tidak mengerjakan tugasnya sendiri.',
      '',
      'Aturan:',
      '- Pecah permintaan menjadi 1 sampai 6 task yang jelas. Untuk permintaan sederhana, cukup 1 task.',
      '- Setiap task diberikan ke satu agent worker yang tersedia. Instruksinya harus jelas, lengkap, dan mandiri (sebutkan konteks, file, atau batasan yang relevan).',
      '- Task yang tidak saling membutuhkan hasil harus punya depends_on kosong supaya bisa berjalan paralel.',
      '- Isi depends_on dengan id task lain hanya jika task itu benar-benar membutuhkan hasilnya. Jangan membuat siklus.',
      '- Id harus unik: t1, t2, dan seterusnya.',
      '- Balas HANYA dengan satu objek JSON valid. Tanpa Markdown, tanpa komentar, tanpa teks lain.',
      '',
      'Format:',
      '{"tasks":[{"id":"t1","agent":"analyst","instruction":"Instruksi yang jelas dan lengkap","depends_on":[]}],"summary":"Ringkasan rencana singkat"}',
    ].join('\n'),
    analyst: [
      'Kamu adalah Analyst dalam sistem multi-agent Jaki. Fokusmu menganalisis konteks, memecah masalah, membandingkan pilihan beserta kelebihan dan kekurangannya, lalu memberi rekomendasi yang beralasan.',
      '',
      '- Kerjakan hanya tugas yang diberikan. Gunakan konteks percakapan, lampiran, dan hasil tugas sebelumnya bila ada.',
      '- Kamu tidak punya tool pencarian web. Jangan mengaku sudah menjelajah web atau mengecek sumber terbaru. Jika butuh data terkini, katakan bahwa itu perlu diverifikasi.',
      '- Bedakan fakta dari asumsi. Jika informasi kurang, tulis asumsi yang kamu pakai.',
      '- Jawab terstruktur dan padat, dalam bahasa yang dipakai user. Hasilmu akan digabung oleh Writer, jadi fokus pada isi, bukan basa-basi.',
    ].join('\n'),
    coder: [
      'Kamu adalah Coder dalam sistem multi-agent Jaki. Fokusmu menulis, memperbaiki, meninjau, dan menjelaskan kode.',
      '',
      '- Gunakan kode atau file dari lampiran dan konteks percakapan. Jangan mengarang isi file yang tidak kamu lihat; jika perlu file lain, sebutkan.',
      '- Tulis kode yang lengkap dan bisa dijalankan di blok Markdown dengan label bahasa. Untuk perubahan pada kode yang sudah ada, jelaskan jelas bagian mana yang diubah dan di mana letaknya.',
      '- Perhatikan edge case, keamanan, dan kompatibilitas. Sebutkan asumsi dan cara mengujinya.',
      '- Kerjakan hanya tugas yang diberikan. Hasilmu akan digabung oleh Writer.',
    ].join('\n'),
    writer: [
      'Kamu adalah Writer (aggregator dan verifier) dalam sistem multi-agent Jaki. Kamu menerima permintaan asli user, rencana Supervisor, dan hasil kerja agent lain. Tugasmu menyusun jawaban akhir untuk user.',
      '',
      '- Gabungkan semua hasil menjadi satu jawaban yang lengkap, konsisten, dan langsung menjawab permintaan user.',
      '- Verifikasi: periksa kontradiksi antar hasil, kode yang belum lengkap, dan klaim yang tidak didukung. Perbaiki bila bisa; jika tidak, sampaikan keterbatasannya.',
      '- Jangan menampilkan instruksi internal atau id task, dan jangan membahas proses multi-agent kecuali relevan bagi user.',
      '- Jika ada task yang gagal atau dilewati, sebutkan dengan jujur bagian yang belum terselesaikan. Jangan mengarang hasilnya.',
      '- Jawab dalam bahasa yang dipakai user, gunakan Markdown seperlunya, dan pertahankan blok kode secara utuh.',
    ].join('\n'),
  };

  /* ---------- Konfigurasi (localStorage: jaki3_orchestra_cfg) ---------- */
  const readRaw = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const writeRaw = r => { try { localStorage.setItem(KEY, JSON.stringify(r)); return true; } catch { return false; } };

  // Hasil selalu lengkap: agent tanpa provider otomatis memakai provider pertama dan modelnya.
  function getCfg() {
    const raw = readRaw(), first = provs[0] || null, agents = {};
    for (const k of ORDER) {
      const a = (raw.agents && raw.agents[k]) || {};
      const own = !!a.provider;
      agents[k] = {
        provider: own ? String(a.provider) : (first ? first.id : ''),
        model: own ? String(a.model || '') : (first ? first.model || '' : ''),
        system: String(a.system || '').trim() || PROMPTS[k],
        enabled: WORKERS.includes(k) ? a.enabled !== false : true,
      };
    }
    return { mode: raw.mode === 'orchestra' ? 'orchestra' : 'chat', agents };
  }
  function setMode(m) { const r = readRaw(); r.mode = m === 'orchestra' ? 'orchestra' : 'chat'; return writeRaw(r); }
  function saveCfg(agents) { const r = readRaw(); r.agents = agents; return writeRaw(r); }
  function resetCfg() { const r = readRaw(); delete r.agents; return writeRaw(r); }

  // Daftar masalah konfigurasi; kosong berarti siap jalan. Menerima { agents } (hasil getCfg atau isi dialog).
  function problems(c) {
    if (!provs.length) return ['Belum ada API. Tambahkan dulu di menu API & Model.'];
    const out = [];
    const workers = WORKERS.filter(k => c.agents[k] && c.agents[k].enabled);
    if (!workers.length) out.push('Tidak ada agent worker yang aktif. Aktifkan Analyst atau Coder.');
    for (const k of ['supervisor', ...workers, 'writer']) {
      const a = c.agents[k] || {};
      if (!a.provider || !provs.some(p => p.id === a.provider)) out.push(`${LABELS[k]}: provider belum dikonfigurasi atau sudah dihapus.`);
      else if (!String(a.model || '').trim()) out.push(`${LABELS[k]}: model belum diisi.`);
    }
    return out;
  }

  // Clone provider yang tersimpan, model diganti dengan model milik agent.
  function resolve(c, k) {
    const a = c.agents[k], p = provs.find(x => x.id === a.provider);
    if (!p || !a.model) throw new Error(`${LABELS[k]}: provider atau model belum dikonfigurasi. Buka "Kelola Orkestra".`);
    return { ...p, model: a.model };
  }
  const provider = k => resolve(getCfg(), k);
  const tag = p => `${p.name} · ${p.model}`;

  /* ---------- Request ke agent ---------- */
  const abortErr = () => new DOMException('Dibatalkan oleh pengguna.', 'AbortError');
  const snip = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200) || '(kosong)';

  // buildBody dipakai ulang apa adanya, lalu system prompt diganti dengan milik agent.
  function agentBody(p, msgs, stream, sys, max) {
    const b = buildBody(p, msgs, stream, max);
    if (p.type === 'anthropic') b.system = sys;
    else b.messages[0] = { role: 'system', content: sys };
    return b;
  }

  // Satu panggilan ke agent. Jika opt.am diberikan, hasil (termasuk streaming) ditulis langsung ke objek itu.
  async function callAgent(k, p, sys, msgs, signal, opt = {}) {
    const am = opt.am || { text: '', think: '' };
    try {
      if (signal.aborted) throw abortErr();
      let r;
      try {
        r = await relay(p, chatUrl(p), { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(agentBody(p, msgs, !!opt.stream, sys, opt.max)) });
      } catch (e) {
        if (signal.aborted || e.name === 'AbortError') throw abortErr();
        throw new Error(`Tidak bisa terhubung ke proxy (${cfg.proxy}). Jalankan "node proxy.js" lalu coba lagi.`);
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 500)}${hint(r.status)}`);
      if ((r.headers.get('content-type') || '').includes('event-stream')) await readSSE(r, p.type, am, opt.tick || (() => {}));
      else {
        let d;
        try { d = await r.json(); } catch { throw new Error('Respons API bukan JSON yang valid.'); }
        parseFull(d, p.type, am);
      }
      if (signal.aborted) throw abortErr();
      return am;
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw abortErr();
      throw new Error(`${LABELS[k]} (${tag(p)}): ${e.message}`);
    }
  }

  /* ---------- Konteks ---------- */
  const userText = m => (m.text || '').trim() || '(lihat lampiran)';
  // Riwayat sebelum pesan user terakhir, dipotong dan harus diawali pesan user.
  function history(msgs) {
    const h = msgs.slice(0, -1).slice(-HIST);
    while (h.length && h[0].role !== 'user') h.shift();
    return h;
  }
  const supervisorSystem = (c, workers) => c.agents.supervisor.system +
    '\n\nAGENT WORKER YANG TERSEDIA (field "agent" hanya boleh berisi salah satu dari ini):\n' + workers.map(k => `- ${k}: ${ROLE[k]}`).join('\n');
  function workerText(s, byId, req) {
    let t = `PERMINTAAN ASLI USER:\n${req}\n\nTUGAS KAMU (id ${s.id}, sebagai ${s.label}):\n${s.instruction}`;
    if (s.depends_on.length) t += '\n\nHASIL TUGAS SEBELUMNYA:\n' + s.depends_on.map(d => `[${d} · ${byId[d].label}]\n${byId[d].output}`).join('\n\n');
    return t + '\n\nKerjakan hanya tugas di atas dan tulis hasilnya langsung.';
  }
  function writerText(req, orc) {
    const parts = orc.steps.map(s => s.status === 'done'
      ? `### ${s.id} · ${s.label} (selesai)\nInstruksi: ${s.instruction}\n\nHasil:\n${s.output}`
      : `### ${s.id} · ${s.label} (GAGAL)\nInstruksi: ${s.instruction}\n\nError: ${s.error}`);
    return `PERMINTAAN ASLI USER:\n${req}\n\nRENCANA SUPERVISOR:\n${orc.summary}\n\nHASIL AGENT:\n\n${parts.join('\n\n')}\n\n` +
      'Susun jawaban akhir untuk user berdasarkan semua hasil di atas. Jika ada task yang gagal atau dilewati, sampaikan dengan jelas bagian yang belum terselesaikan dan jangan mengarang hasilnya.';
  }

  /* ---------- Parser & validasi rencana Supervisor ---------- */
  function parsePlan(text, workers) {
    const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error(`Supervisor tidak menghasilkan JSON. Keluaran: ${snip(text)}`);
    let j;
    try { j = JSON.parse(t.slice(a, b + 1)); }
    catch (e) { throw new Error(`Supervisor menghasilkan JSON tidak valid (${e.message}). Keluaran: ${snip(text)}`); }
    if (!j || !Array.isArray(j.tasks) || !j.tasks.length) throw new Error(`Rencana Supervisor tidak berisi task. Keluaran: ${snip(text)}`);
    if (j.tasks.length > MAX_TASKS) throw new Error(`Rencana Supervisor terlalu banyak (${j.tasks.length} task, maksimal ${MAX_TASKS}).`);
    const ids = new Set(), tasks = [];
    j.tasks.forEach((raw, i) => {
      const x = raw && typeof raw === 'object' ? raw : {};
      const id = String(x.id == null ? '' : x.id).trim();
      if (!id) throw new Error(`Task ke-${i + 1} dari Supervisor tidak punya id.`);
      if (ids.has(id)) throw new Error(`Id task "${id}" dipakai lebih dari sekali.`);
      ids.add(id);
      const agent = String(x.agent || '').trim().toLowerCase();
      if (!workers.includes(agent)) throw new Error(`Task ${id}: agent "${x.agent}" tidak valid. Yang tersedia: ${workers.join(', ')}.`);
      const instruction = String(x.instruction || '').trim();
      if (!instruction) throw new Error(`Task ${id}: instruksi kosong.`);
      if (x.depends_on != null && !Array.isArray(x.depends_on)) throw new Error(`Task ${id}: depends_on harus berupa array.`);
      tasks.push({ id, agent, instruction, depends_on: [...new Set((x.depends_on || []).map(d => String(d).trim()))] });
    });
    for (const t2 of tasks) for (const d of t2.depends_on) {
      if (d === t2.id) throw new Error(`Task ${t2.id} bergantung pada dirinya sendiri (siklus dependency).`);
      if (!ids.has(d)) throw new Error(`Task ${t2.id} bergantung pada "${d}" yang tidak ada dalam rencana.`);
    }
    // Urutan topologis (Kahn). Jika ada sisa yang tidak bisa diurutkan berarti ada siklus.
    const left = new Map(tasks.map(t2 => [t2.id, new Set(t2.depends_on)]));
    const order = [];
    while (left.size) {
      const ready = [...left].filter(([, s]) => !s.size).map(([id]) => id);
      if (!ready.length) throw new Error(`Rencana Supervisor memiliki siklus dependency antara task: ${[...left.keys()].join(', ')}.`);
      for (const id of ready) { left.delete(id); order.push(id); }
      for (const s of left.values()) ready.forEach(id => s.delete(id));
    }
    return { tasks, order, summary: String(j.summary || '').trim() || `${tasks.length} task` };
  }

  /* ---------- Jalankan Orchestra ----------
     o.msgs   : percakapan, pesan terakhir adalah pesan user (tanpa pesan assistant yang sedang dibuat)
     o.am     : pesan assistant; am.text diisi streaming oleh Writer, am.orchestra diisi metadata proses
     o.signal : satu AbortSignal untuk Supervisor, semua worker, dan Writer
     o.memory : blok memori opsional (hasil Mem.recall), ditambahkan ke system prompt tiap agent
     o.onUpdate : dipanggil setiap status/teks berubah agar UI digambar ulang */
  async function run(o) {
    const { msgs, am, signal } = o;
    const upd = () => { try { if (o.onUpdate) o.onUpdate(); } catch { /* UI tidak boleh menghentikan proses */ } };
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user') throw new Error('Tidak ada pesan user untuk diproses.');
    const c = getCfg();
    const bad = problems(c);
    if (bad.length) throw new Error('Konfigurasi Orchestra belum lengkap:\n- ' + bad.join('\n- '));
    const workers = WORKERS.filter(k => c.agents[k].enabled);
    const P = {};
    for (const k of ['supervisor', ...workers, 'writer']) P[k] = resolve(c, k);

    const mem = o.memory ? '\n\n' + o.memory : '';
    const hist = history(msgs), req = userText(last);
    const turn = text => [...hist, { role: 'user', text, atts: last.atts || [] }];
    const tok = { in: 0, out: 0 };
    const count = m => { tok.in += m.in || 0; tok.out += m.out || 0; };
    const orc = am.orchestra = {
      rid: Math.random().toString(36).slice(2, 9), phase: 'planning', summary: '', plan: [], steps: [],
      supervisor: tag(P.supervisor), writer: tag(P.writer),
    };
    upd();

    try {
      // 1. Supervisor menyusun rencana
      const sup = await callAgent('supervisor', P.supervisor, supervisorSystem(c, workers) + mem,
        turn(`Susun rencana kerja untuk permintaan user berikut. Balas HANYA dengan JSON valid.\n\nPERMINTAAN USER:\n${req}`), signal, { max: 2048 });
      count(sup);
      const plan = parsePlan(sup.text, workers);
      orc.summary = plan.summary;
      orc.plan = plan.tasks.map(t => ({ ...t, depends_on: [...t.depends_on] }));
      orc.steps = plan.tasks.map(t => ({
        id: t.id, agent: t.agent, label: LABELS[t.agent], model: tag(P[t.agent]), instruction: t.instruction,
        depends_on: [...t.depends_on], status: 'pending', output: '', error: '',
      }));
      orc.phase = 'working';
      upd();

      // 2. Scheduler: tiap task menunggu dependency-nya lewat Promise.all; task tanpa dependency langsung jalan bersamaan.
      const byId = Object.fromEntries(orc.steps.map(s => [s.id, s]));
      const jobs = {};
      for (const id of plan.order) { // urutan topologis: dependency selalu sudah punya job
        const s = byId[id];
        jobs[id] = (async () => {
          await Promise.all(s.depends_on.map(d => jobs[d]));
          if (signal.aborted) { s.status = 'failed'; s.error = 'Dibatalkan oleh pengguna.'; return upd(); }
          const failed = s.depends_on.filter(d => byId[d].status !== 'done');
          if (failed.length) { s.status = 'failed'; s.error = `Dilewati karena task yang dibutuhkan gagal: ${failed.join(', ')}.`; return upd(); }
          s.status = 'running';
          upd();
          try {
            const w = await callAgent(s.agent, P[s.agent], c.agents[s.agent].system + mem, turn(workerText(s, byId, req)), signal);
            count(w);
            const out = w.text.trim();
            if (!out) throw new Error(`${s.label} (${s.model}): jawaban kosong.`);
            s.output = out;
            s.status = 'done';
          } catch (e) {
            s.status = 'failed';
            s.error = signal.aborted || e.name === 'AbortError' ? 'Dibatalkan oleh pengguna.' : e.message;
          }
          upd();
        })();
      }
      await Promise.all(Object.values(jobs));
      if (signal.aborted) throw abortErr();
      if (!orc.steps.some(s => s.status === 'done'))
        throw new Error('Semua agent worker gagal, jadi jawaban akhir tidak bisa disusun.\n' + orc.steps.map(s => `- ${s.id} (${s.label}): ${s.error}`).join('\n'));

      // 3. Writer menggabungkan hasil dan streaming langsung ke am.text
      orc.phase = 'writing';
      upd();
      await callAgent('writer', P.writer, c.agents.writer.system + mem, turn(writerText(req, orc)), signal, { stream: true, am, tick: upd });
      if (!am.text.trim()) throw new Error(`Writer (${tag(P.writer)}): jawaban kosong.`);
      am.in = (am.in || 0) + tok.in;
      am.out = (am.out || 0) + tok.out;
      orc.phase = 'done';
      upd();
    } catch (e) {
      const stopped = signal.aborted || e.name === 'AbortError';
      orc.phase = stopped ? 'stopped' : 'error';
      for (const s of orc.steps) if (s.status === 'pending' || s.status === 'running') { s.status = 'failed'; s.error = stopped ? 'Dibatalkan oleh pengguna.' : 'Tidak dijalankan karena proses berhenti.'; }
      upd();
      throw stopped ? abortErr() : e;
    }
  }

  return { ORDER, WORKERS, LABELS, DESC, getCfg, saveCfg, resetCfg, setMode, problems, provider, run };
})();
