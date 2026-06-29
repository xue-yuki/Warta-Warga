# 🏘️ Warta Warga

Asisten **Info Bansos + Anti-Hoaks** via WhatsApp. Dua agent AI:

- **Agent 1 — Verifikator Sumber** (pipeline data): tarik info bansos dari sumber resmi terkurasi → sederhanakan & strukturkan (LLM) → tag wilayah → simpan ke Knowledge Base (vector store).
- **Agent 2 — Asisten Warga** (di WhatsApp): jawab pertanyaan via **RAG** (selalu cantum sumber) & periksa klaim dengan **sistem 3-label** (✅ Terverifikasi / ⚠️ Belum bisa dipastikan / ❌ Bertentangan).

Implementasi dari [`prd.md`](./prd.md). **Local-first**: jalan tanpa cloud (SQLite + embeddings lokal). LLM lewat **OpenRouter** (model bebas dipilih via env).

## Arsitektur

```
WhatsApp ──Baileys──► src/wa/bot.js ──► src/agent2/handler.js
                          │                 ├─ classify.js  (info/klaim/lain)
                          │                 ├─ rag.js        (jawab + sumber)
                          │                 └─ claim.js      (3-label)
                          ▼
                     SQLite (src/db) ◄── kb/vectorStore.js ◄── embeddings/ (lokal)
                          ▲
   sumber resmi ──► src/agent1 (fetch→parse→structure[LLM]→store)
```

Prinsip PRD yang ditegakkan kode:
- **Traceable**: jawaban tanpa dokумен relevan → "belum punya info", tidak menebak.
- **Whitelist sumber** (`data/sources_whitelist.json`): Agent 1 hanya proses host `.go.id` dll.
- **Ketidakhadiran = ⚠️ bukan ❌** (aturan keras di `claim.js`).
- **Privasi by design**: tak ada tabel identitas warga; `log_interaksi` anonim; status "sudah disapa" hanya di memori.
- **Stateless bot**: konteks grup/wilayah selalu di-fetch dari DB tiap event.

## Setup Cepat

```bash
npm install
cp .env.example .env
npm run init
npm run seed
npm run bot
```

Isi `OPENROUTER_API_KEY` di `.env` bila ingin jawaban full-LLM. Untuk mode lokal/offline, kosongkan `SUPABASE_DB_URL` agar aplikasi memakai SQLite.

Default aman untuk menjalankan bot:

```bash
SCRAPE_ON_BOOT=false
NEW_INFO_BROADCAST_AUTO=false
ON_DEMAND_DISCOVERY=false
PENDING_BROADCAST_AUTO=false
```

Dengan konfigurasi ini, bot tidak scrape, tidak discovery daerah via web search, dan tidak broadcast otomatis saat project start. Broadcast laporan tetap bisa dilakukan manual dari dashboard.

> Tanpa `OPENROUTER_API_KEY`, bot tetap jalan dengan **mode fallback** (klasifikasi heuristik + jawaban ekstraktif + klaim konservatif ⚠️). Untuk RAG/klaim penuh, isi key.
> Embeddings default `local` (Xenova/all-MiniLM-L6-v2, unduh ~25MB sekali). Set `EMBEDDINGS_PROVIDER=hashing` untuk mode tanpa unduh.

## Panduan `package.json`

### Init DB & Data

Gunakan command ini untuk menyiapkan database dan data awal.

| Command | Fungsi | Aman untuk |
|---|---|---|
| `npm run init` | Inisialisasi schema database dan cek konfigurasi runtime. Tidak menyalakan WhatsApp. | Setup awal, verifikasi DB |
| `npm run seed` | Isi Knowledge Base dengan data sintetis demo. | Demo lokal |
| `npm run seed:data` | Alias dari `npm run seed`. | Demo lokal |
| `npm run seed:laporan` | Isi data laporan penipuan/misinformasi untuk dashboard approval. | Demo fitur laporan |

Catatan Supabase: kalau `SUPABASE_DB_URL` terisi, command DB akan mengarah ke Supabase/Postgres. Untuk test lokal yang tidak menyentuh cloud, jalankan dengan:

```bash
SUPABASE_DB_URL= npm run init
SUPABASE_DB_URL= npm run seed
```

### Run Aplikasi

Gunakan command ini untuk menjalankan service utama atau pekerjaan operasional.

| Command | Fungsi | Catatan |
|---|---|---|
| `npm start` | Menjalankan aplikasi utama. | Sama dengan `npm run bot` |
| `npm run bot` | Menyalakan WhatsApp bot, dashboard lokal, dan scheduler sesuai `.env`. | Scan QR WhatsApp saat pertama kali |
| `npm run ingest -- ...` | Ingest satu URL/file resmi ke Knowledge Base. | Butuh sumber lolos whitelist |
| `npm run scrape` | Jalankan scrape Agent 1 manual. | Butuh `OPENROUTER_API_KEY` untuk strukturisasi |
| `npm run dashboard:demo` | Dashboard approval lokal dengan broadcaster console. | Tidak kirim WhatsApp sungguhan |
| `npm run warmup:aduankonten` | Warm-up session/browser AduanKonten. | Untuk fitur portal AduanKonten |
| `npm run migrate:supabase` | Migrasi data lokal ke Supabase. | Pastikan target `.env` benar sebelum menjalankan |

### Test & Demo

Command berikut dipakai untuk validasi perilaku tanpa menjalankan bot produksi penuh.

| Command | Fungsi |
|---|---|
| `npm run demo` | Uji Agent 2 di terminal tanpa WhatsApp. |
| `npm run demo:broadcast` | Demo alur broadcast lokal tanpa LLM/scrape live. |
| `npm run demo:wa-validation` | Demo validasi registrasi dan perilaku WhatsApp. |
| `npm run demo:crawl-broadcast` | Demo crawl sampai broadcast gambar. Gunakan `DEMO_ONCE=true` untuk sekali jalan. |
| `npm run demo:lapor` | Demo pipeline laporan penipuan sampai approval/broadcast. |
| `npm run demo:aduankonten` | Demo pipeline AduanKonten. |
| `npm run e2e:broadcast` | E2E scrape -> strukturisasi -> broadcast console. |
| `npm run e2e:lapor` | E2E fitur lapor penipuan. |
| `npm run test:brain` | Test brain/tool calling Agent 2. |
| `npm run test:checkurl` | Test deteksi/cek URL. |
| `npm run test:vision` | Test pembacaan gambar via vision provider. |
| `npm run check:laporgub` | Cek status Laporgub manual. |
| `npm run check:aduankonten` | Cek status AduanKonten manual. |

Untuk test yang harus terisolasi dari Supabase produksi, prefix command dengan `SUPABASE_DB_URL=` seperti contoh init di atas.

Untuk sengaja mengaktifkan broadcast otomatis info bansos baru dari hasil scrape, set `NEW_INFO_BROADCAST_AUTO=true`. Jangan aktifkan ini untuk demo synthetic atau saat bot terhubung ke grup sungguhan kecuali memang ingin semua info baru langsung disebar.

## Agent 1 on-demand

```bash
# Dari URL resmi (harus lolos whitelist), butuh OPENROUTER_API_KEY:
npm run ingest -- url https://kemensos.go.id/xxx --wilayah kabupaten:banyumas

# Dari file lokal (sumber_url tetap wajib):
npm run ingest -- file ./pengumuman.txt --url https://dinsos.banyumaskab.go.id/x --wilayah kabupaten:banyumas
```

## Test broadcast gambar sinkron

Gunakan script demo ini untuk memastikan teks broadcast dan poster yang dikirim berasal dari baris data yang sama.

```bash
# Test lokal aman: tidak kirim WhatsApp, pakai data sintetis, cek mapping image_id/image_path.
DEMO_ONCE=true DEMO_CRAWL_MODE=synthetic DEMO_IMAGE_MODE=mock DEMO_USER=6281234567890 npm run demo:crawl-broadcast
```

Hasil yang benar:

```text
id=1 -> image_id=info_1 -> data/posters/info_1.png
id=2 -> image_id=info_2 -> data/posters/info_2.png
id=3 -> image_id=info_3 -> data/posters/info_3.png
```

Setiap poster juga punya metadata pendamping, misalnya `data/posters/info_1.json`, berisi `info_id`, `program`, `sumber_url`, `model`, dan prompt yang dipakai saat generate. Ini dipakai untuk audit kalau gambar dan teks terlihat tidak cocok.

Untuk test kirim ke user WhatsApp sungguhan:

```bash
DEMO_SEND_WA=true DEMO_ONCE=true DEMO_CRAWL_MODE=synthetic DEMO_IMAGE_MODE=real DEMO_USER=62812xxxx npm run demo:crawl-broadcast
```

Catatan:
- `DEMO_IMAGE_MODE=real` memakai image generator sungguhan, jadi butuh `IMAGE_API_KEY`, `OPENAI_API_KEY`, atau key lain sesuai `.env`.
- `DEMO_IMAGE_MODE=mock` hanya untuk test plumbing DB/broadcast. Mode ini menyalin bytes poster cache, jadi jangan dipakai untuk menilai kecocokan visual.
- Broadcast tidak lagi memakai fallback random poster. Kalau `image_path` untuk baris info tidak ada atau file hilang, pesan dikirim text-only.
- Default interval script adalah 12 jam. Untuk demo cepat satu kali, selalu pakai `DEMO_ONCE=true`.

## Pemakaian di WhatsApp

| Konteks | Perilaku |
|---|---|
| **Japri** | Selalu dengar. Pesan pertama → sapaan. Tanya info / cek klaim privat. |
| **Grup** | Diam. `/start <daerah>` → daftarkan grup + set wilayah. Mention bot → jawab/cek di depan umum. |

Contoh di grup: `/start Kab. Banyumas` lalu `@WartaWarga ada bansos baru di sini?`

## Definition of Done (PRD §9)

- [x] Bot WA: bedakan grup vs japri (F2.1), `/start` (F2.2), anti-loop `fromMe` (F2.3)
- [x] Japri: tanya → RAG + sumber (F2.4)
- [x] Cek klaim: 3-label + alasan + sumber (5.5)
- [x] Agent 1: tarik & strukturkan dari sumber (on-demand, F1.1–F1.4)
- [x] Tag wilayah hierarkis untuk daerah demo (Banyumas) (§6.3)

## Migrasi ke Supabase/pgvector (lanjutan)

Vector store kini di tabel `kb_chunks` (embedding JSON). Untuk produksi, ganti `src/kb/vectorStore.js` + `src/db` ke Supabase pgvector tanpa mengubah Agent 1/2 (interface `indexInfo`/`search` tetap).
