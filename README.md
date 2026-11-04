# Jaki

Asisten AI berbasis web yang jalan di komputer sendiri. Pakai API key milik sendiri (Anthropic, OpenAI, MiniMax, DeepSeek, Groq, OpenRouter, Gemini, Ollama, LM Studio, dan provider lain yang kompatibel), tanpa akun dan tanpa server pihak ketiga selain provider yang lo pilih.

## Fitur

* **Chat Biasa** dengan streaming, blok kode berwarna (salin dan unduh), tabel, dan Markdown.

* **Lampiran**: gambar, PDF (provider tipe Anthropic), dan file teks atau kode. Tempel gambar langsung, atau seret file.

* **Orchestra (multi-agent)**: Supervisor menyusun rencana, Analyst dan Coder bekerja paralel sesuai dependensi, lalu Writer menggabungkan hasilnya. Tiap agent bisa memakai provider dan model berbeda.

* **Memori lokal**: fakta jangka panjang tentang pengguna disimpan di SQLite (`jaki-memory.db`) di komputer ini, bisa dilihat, ditambah, dan dihapus dari menu Memori.

* **Media**: video sinematik lewat MiniMax Hailuo, dan animasi HTML/CSS/SVG yang tampil di pratinjau aman (iframe sandbox tanpa akses jaringan). Perintah manual: `/video ...`, `/animasi ...`, `/chat ...`.

* Banyak provider sekaligus, ganti model dari header, mode gelap, cari chat (Ctrl+K), ganti nama chat, ekspor chat ke `.md`.

## Persyaratan

* Node.js 18 atau lebih baru untuk proxy.

* Untuk memori: Node 22.13+ (SQLite bawaan), atau Node 18+ dengan `npm i better-sqlite3`. Tanpa itu, chat tetap jalan tapi memori nonaktif.

* Browser modern.

## Cara menjalankan

1. Jalankan proxy:

   ```
   node proxy.js
   
   ```

2. Sajikan halamannya lewat server statis apa saja, contoh:

   ```
   npx serve -l tcp://127.0.0.1:5500 .
   # atau
   python -m http.server 5500 --bind 127.0.0.1
   
   ```

   Jalankan dari folder proyek ini, lalu buka `http://127.0.0.1:5500/` (atau pakai ekstensi Live Server di VS Code).

3. Di Jaki, buka **API & Model**, pilih preset atau isi Base URL dan API key, ambil daftar model, lalu **Simpan & pakai**. Titik di header hijau berarti proxy terhubung.

## Konfigurasi proxy

Semua opsional, lewat variabel lingkungan:

| Variabel | Default | Fungsi | 
| ----- | ----- | ----- | 
| `JAKI_HOST` | `127.0.0.1` | Alamat bind. Isi `0.0.0.0` agar perangkat lain di Wi-Fi yang sama bisa akses. | 
| `JAKI_PORT` | `3001` | Port proxy. | 
| `JAKI_DB` | `jaki-memory.db` | Lokasi file memori. | 
| `JAKI_ORIGINS` | kosong | Origin halaman tambahan yang diizinkan, pisahkan dengan koma. | 
| `JAKI_ALLOW_NULL` | kosong | Isi `1` jika halaman dibuka langsung dari `file://`. | 

Contoh (Windows PowerShell): `$env:JAKI_HOST="0.0.0.0"; node proxy.js`

## Keamanan dan privasi

* **API key** disimpan di localStorage browser dan dikirim lewat header ke proxy lokal, yang meneruskannya ke provider pilihanmu. Key tidak ditulis ke file.

* Proxy hanya menerima request dari halaman di `localhost`, `127.0.0.1`, atau IP jaringan lokal. Origin lain ditolak, dan alamat metadata cloud diblokir sebagai tujuan.

* Default-nya proxy hanya bisa diakses dari komputer ini. Kalau lo membukanya ke jaringan lokal (`JAKI_HOST=0.0.0.0`), pastikan jaringannya tepercaya.

* **Memori** memakai model pilihanmu untuk mengekstrak fakta dari percakapan, jadi isi pesan terkirim ke provider tersebut (sama seperti chat biasa). Pola rahasia seperti API key, token, password, dan nomor kartu atau KTP disaring sebelum disimpan. Matikan memori dari menu Memori kalau tidak mau.

* Pratinjau animasi berjalan di iframe `sandbox` dengan CSP yang memblokir jaringan, jadi kode hasil model tidak bisa membaca localStorage atau API key.

## Struktur

| File | Isi | 
| ----- | ----- | 
| `index.html` | Antarmuka dan logika chat | 
| `orchestra.js` | Sistem multi-agent | 
| `memory.js` | Klien memori | 
| `media.js` | Router video/animasi dan klien MiniMax | 
| `proxy.js` | Proxy relay dan server memori SQLite | 

## Lisensi

Proyek ini dirilis di bawah lisensi [MIT](LICENSE). Hak cipta (c) 2026 dzakimaulidh.