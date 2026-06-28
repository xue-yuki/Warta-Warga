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

## Setup

```bash
npm install
cp .env.example .env      # isi OPENROUTER_API_KEY bila ingin jawaban full-LLM
npm run init              # init skema DB + cache config, tanpa menyalakan WhatsApp
npm run seed              # isi KB dengan data sintetis (jalan tanpa API key)
npm run demo              # uji Agent 2 di terminal (tanpa WhatsApp) 
npm run bot               # nyalakan bot → scan QR di WhatsApp
```

> Tanpa `OPENROUTER_API_KEY`, bot tetap jalan dengan **mode fallback** (klasifikasi heuristik + jawaban ekstraktif + klaim konservatif ⚠️). Untuk RAG/klaim penuh, isi key.
> Embeddings default `local` (Xenova/all-MiniLM-L6-v2, unduh ~25MB sekali). Set `EMBEDDINGS_PROVIDER=hashing` untuk mode tanpa unduh.

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
