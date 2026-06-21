# PRD — Agent AI Warta Warga

Product Requirements Document
Proyek: Warta Warga — Asisten Info Bansos + Anti-Hoaks via WhatsApp
Studi Kasus: KS1 (Komunitas — Akses Informasi Valid)
Versi: 0.1 | Status: Draft untuk build

---

## 1. Konteks Singkat

Warga butuh info bantuan sosial, tapi *malas* mencari (info tersebar & bahasa birokrasi) dan *sungkan* bertanya (takut dianggap bodoh/merepotkan). Warta Warga membawa info resmi ke tempat warga (WhatsApp), menyederhanakan bahasanya, dan membantu memverifikasi klaim yang beredar — tanpa menyimpan data pribadi warga.

Sistem punya **dua agent AI**:

- **Agent 1 — Verifikator Sumber:** menarik & memvalidasi info bansos dari sumber resmi terkurasi, menyiapkannya untuk disebar. Jalan di belakang layar (pipeline data).
- **Agent 2 — Asisten Warga:** menghadapi warga langsung di WhatsApp. Menjawab pertanyaan (RAG) dan memeriksa klaim (3-label).

Dokumen ini mendefinisikan requirement kedua agent + infrastruktur bersama yang mereka pakai.

---

## 2. Tujuan & Non-Tujuan

### Tujuan
- Warga dapat info bansos yang akurat & dapat dilacak ke sumber resmi, dalam bahasa sederhana, lewat WhatsApp.
- Warga dapat mengecek kebenaran klaim/kabar bansos yang mereka ragukan.
- Info yang disebar relevan dengan wilayah warga (tidak salah daerah).
- Sistem tidak menyimpan data pribadi warga dan tidak menyebar ke yang tidak meminta.

### Non-Tujuan (eksplisit di luar cakupan)
- Bukan sistem pendaftaran bansos (tidak memproses pendaftaran resmi).
- Bukan penentu kelayakan resmi (tidak memvonis "kamu pasti dapat/tidak").
- Tidak mengklaim 100% benar — klaim sistem adalah **100% dapat dilacak ke sumber**, bukan kebenaran mutlak.
- Tidak melakukan pencarian bebas ke seluruh internet (hanya sumber terkurasi).

---

## 3. Prinsip Desain (mengikat semua agent)

1. **Traceable, bukan omniscient.** Setiap jawaban/sebaran selalu mencantumkan sumber. Kalau tidak ada sumber, sistem berkata tidak tahu.
2. **Sumber terkurasi.** Hanya menarik dari daftar sumber resmi yang ditetapkan (whitelist `.go.id`, Kemensos, dinsos). Tidak menelan blog/forum/media acak.
3. **Manusia tetap berperan.** Untuk keputusan penting (kelayakan, pendaftaran), warga diarahkan verifikasi ke pengurus/instansi.
4. **Privasi by design.** Tidak membangun database warga. Opt-in lewat grup/japri. Demo memakai data sintetis.
5. **Stateless bot, stateful database.** Agent tidak "mengingat" di memori; konteks (daerah grup, status `/start`) selalu ditarik dari database tiap event.

---

## 4. Agent 1 — Verifikator Sumber

### 4.1 Tujuan
Menjaga agar semua info yang masuk ke sistem berasal dari sumber resmi, sudah disederhanakan, dan diberi tag wilayah — siap dipakai Agent 2 (RAG) dan untuk broadcast.

### 4.2 Input
- Daftar sumber resmi terkurasi (URL situs/halaman pengumuman bansos).
- (Untuk demo) dokumen/pengumuman sintetis yang disiapkan tim.

### 4.3 Proses
1. **Fetch** — tarik konten dari sumber (fetch/axios untuk HTML statis; Playwright bila berat JS; RSS bila tersedia).
2. **Parse** — bersihkan jadi teks inti (Cheerio): buang menu/iklan/footer.
3. **Strukturkan & sederhanakan (LLM)** — ubah teks birokrasi jadi objek terstruktur:
   - `program`, `ringkasan_bahasa_sederhana`, `syarat[]`, `tanggal_penting`, `cara_daftar`, `wilayah_tag`, `sumber_url`, `tanggal_ambil`.
4. **Tag wilayah** — tetapkan level: `nasional` / `provinsi:<x>` / `kabupaten:<x>`.
5. **Simpan** — masuk ke Knowledge Base (vector store) + tabel `info_bansos`.

### 4.4 Output
- Entri info terstruktur tersimpan, siap di-RAG dan di-broadcast.

### 4.5 Requirement fungsional
- F1.1: Hanya memproses URL yang ada di whitelist sumber.
- F1.2: Setiap entri WAJIB menyimpan `sumber_url` + `tanggal_ambil`.
- F1.3: Setiap entri WAJIB punya `wilayah_tag`.
- F1.4: Jika konten sumber tidak bisa di-parse, log error & skip — jangan menebak isi.
- F1.5 (bonus): dapat dijadwalkan berkala (scheduler). Untuk versi lomba, cukup dapat dijalankan manual/on-demand.

---

## 5. Agent 2 — Asisten Warga

### 5.1 Tujuan
Menjawab pertanyaan warga & memeriksa klaim, lewat WhatsApp, dengan jawaban yang di-grounding ke Knowledge Base.

### 5.2 Input
- Pesan warga (teks; voice note → teks bila sempat/bonus).
- Konteks: JID pengirim, apakah grup/japri, daerah (dari DB bila ada).

### 5.3 Klasifikasi maksud
Agent menentukan pesan masuk termasuk:
- **(A) Tanya info** — "syarat PKH apa?", "ada bansos di daerahku?"
- **(B) Ajukan klaim** — "ini bener nggak: ada bantuan 600rb klik link..."
- **(C) Lain-lain** — sapaan, di luar topik → arahkan balik ke fungsi sistem.

### 5.4 Alur (A) Tanya info — RAG
1. Ambil dokumen relevan dari Knowledge Base (filter wilayah bila perlu).
2. Susun jawaban HANYA dari dokumen tersebut + cantumkan sumber.
3. Jika tidak ada dokumen relevan → "belum punya info ini dari sumber resmi", jangan menebak.
4. Untuk kelayakan personal → jelaskan tergantung DTKS + arahkan cek mandiri (cekbansos.kemensos.go.id) / pengurus.

### 5.5 Alur (B) Ajukan klaim — Sistem 3-Label
Bandingkan klaim ke Knowledge Base, keluarkan SATU label + alasan + sumber:

| Label | Kondisi | Aksi |
|---|---|---|
| ✅ **Terverifikasi** | Cocok dengan sumber resmi | Tampilkan info benar + sumber |
| ⚠️ **Belum bisa dipastikan** | Tidak ditemukan di sumber terkurasi | "Belum bisa dipastikan, jangan transfer uang/kasih data dulu, konfirmasi ke RT/instansi" |
| ❌ **Bertentangan** | Berlawanan dengan sumber resmi | Tampilkan versi yang benar + sumber |

> Aturan keras: ketidakhadiran di sumber = ⚠️, **BUKAN** ❌. Jangan mencap hoaks pada bantuan yang mungkin asli.

### 5.6 Perilaku per kanal

| Konteks | Default | Pemicu respons | Fungsi |
|---|---|---|---|
| **Japri** (`@s.whatsapp.net`) | Selalu dengar | Pesan apa pun | Tanya info + cek klaim privat (lawan "sungkan"). Pesan pertama → sapaan pembuka. |
| **Grup** (`@g.us`) | Diam | `/start`, `@mention` bot | `/start` → daftarkan grup + set wilayah. Mention → cek klaim/jawab di depan umum. |

### 5.7 Requirement fungsional
- F2.1: Bedakan grup vs japri dari JID sebelum memproses.
- F2.2: Di grup, abaikan pesan kecuali `/start` atau mention bot.
- F2.3: Abaikan pesan dari diri sendiri (`fromMe`) — cegah loop.
- F2.4: Setiap jawaban info/klaim WAJIB menyertakan sumber (kecuali label ⚠️ yang memang tak bersumber).
- F2.5: Jangan pernah menyatakan kelayakan resmi sebagai kepastian.
- F2.6: Pesan pertama di japri → kirim sapaan pembuka berisi fungsi sistem.
- F2.7 (bonus): voice note → transkrip → diperlakukan seperti teks.

---

## 6. Infrastruktur Bersama

### 6.1 Knowledge Base (RAG)
- Dokumen resmi → embedding → vector store (pgvector di Supabase).
- Tiap chunk menyimpan metadata: `sumber_url`, `wilayah_tag`, `tanggal_ambil`.
- Query Agent 2 mengambil top-k chunk relevan (opsional filter wilayah).

### 6.2 Database (memory) — skema awal

```
grup
  id_grup        (PK, JID grup)
  daerah         (mis. "Kab. Banyumas")
  wilayah_tag    (mis. "kabupaten:banyumas")
  status_start   (boolean)
  tgl_start

info_bansos
  id             (PK)
  program
  ringkasan
  syarat         (json/text)
  tanggal_penting
  cara_daftar
  wilayah_tag
  sumber_url
  tanggal_ambil

log_interaksi   (anonim — TANPA identitas pribadi)
  id
  konteks        (grup/japri)
  jenis          (info/klaim/lain)
  label          (untuk klaim: verified/unverified/contradict)
  wilayah_tag
  timestamp
```

> Catatan privasi: `log_interaksi` hanya untuk dashboard tren kebutuhan — TIDAK menyimpan nomor, nama, atau isi pribadi yang mengidentifikasi warga.

### 6.3 Filter wilayah (hierarkis)
Info dikirim/dipakai untuk sebuah grup jika `wilayah_tag` info termasuk:
`nasional` ATAU `provinsi` grup ATAU `kabupaten` grup.

---

## 7. Sumber Data

- **Terkurasi (whitelist):** situs Kemensos, dinsos/pemda terkait, portal `.go.id`, data.go.id.
- **Sintetis (untuk demo):** pengumuman & pertanyaan warga buatan sendiri untuk simulasi alur penuh.
- Seluruh sumber dicantumkan (disclosure). Tidak memakai data pribadi/sensitif.

---

## 8. Responsible AI (wajib ditunjukkan)

| Risiko | Mitigasi |
|---|---|
| Misinformasi / halusinasi | Grounding ke sumber (RAG) + cantum sumber; tidak ada sumber → "tidak tahu" |
| Mencap hoaks pada info asli | Sistem 3-label; ragu → ⚠️ bukan ❌ |
| Keputusan penting salah | AI memberi info, bukan vonis; kelayakan/pendaftaran → verifikasi manusia |
| Privasi warga | Tanpa database warga; opt-in; demo data sintetis; log anonim |
| Info salah daerah | Tag wilayah per grup + filter hierarkis |

---

## 9. Definition of Done (versi lomba)

Inti (wajib):
- [ ] Bot WA jalan: bedakan grup vs japri, `/start` terdeteksi, anti-loop.
- [ ] Japri: warga tanya → Agent 2 jawab via RAG dengan sumber.
- [ ] Cek klaim: keluar label 3-tingkat + alasan + sumber.
- [ ] Agent 1: minimal dapat menarik & menstrukturkan dari sumber (boleh on-demand).
- [ ] Tag wilayah berfungsi untuk minimal 1 daerah demo.

Bonus (kalau waktu sisa):
- [ ] Scheduler Agent 1 berkala
- [ ] Generate poster otomatis
- [ ] Voice note → teks
- [ ] Dashboard pengurus + landing page

---

## 10. Di Luar Cakupan (jangan dibangun dulu)

- Pencarian bebas ke internet / Google.
- Integrasi langsung ke sistem pemerintah.
- Pendaftaran bansos resmi.
- Cakupan seluruh Indonesia (cukup 1 daerah contoh untuk demo).
- Aplikasi mobile native.

---

## 11. Catatan Teknis (referensi build)

- WA: Baileys (Node) — grup baca/posting + japri. Cek `fromMe`, deteksi JID `@g.us` vs `@s.whatsapp.net`, deteksi mention via `contextInfo.mentionedJid`.
- LLM: via API (volume tinggi japri → model cepat-murah; reasoning klaim → model lebih dalam — pola seperti Kelola.ai).
- Vector store: pgvector di Supabase.
- Backend: Node.js/Python.
- Konteks selalu di-fetch fresh dari DB (jangan cache di memori bot — aman saat restart).