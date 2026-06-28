# AduanKonten Agent 2 - Teknis

Dokumen ini menjelaskan integrasi laporan konten negatif ke `aduankonten.id` dari Agent 2 Warta Warga.

## Tujuan

Fitur AduanKonten membantu warga mengirim laporan konten negatif dari WhatsApp tanpa perlu mengisi form portal secara manual. Bot menyiapkan URL, kategori, alasan, lampiran, submit, lalu menyimpan kode laporan untuk tracking.

Komponen utama:

- `src/agent2/lapor-konten.js`: intent, parsing URL/kategori/alasan, konfirmasi user, dan pencatatan DB.
- `src/portal/aduankonten.js`: otomasi browser AduanKonten memakai Patchright.
- `src/agent2/aduankonten-checker.js`: polling status tiket dan notifikasi WhatsApp.
- `src/agent2/layanan-checker.js`: scheduler layanan Agent 2 untuk LaporGub dan AduanKonten.
- `scripts/demo-aduankonten.js`: dry-run, probe, dan live submit manual.
- `scripts/warmup-aduankonten.js`: membuat/menyegarkan session browser.

## Runtime Browser

Jalur AduanKonten memakai:

- `patchright` untuk browser automation.
- `ghost-cursor` untuk interaksi form yang lebih natural.
- Persistent profile `ADUANKONTEN_USER_DATA_DIR`.
- Storage state `ADUANKONTEN_SESSION_PATH`.

`playwright-core` masih ada di project untuk modul lain seperti LaporGub/BrightData, tetapi portal AduanKonten memakai Patchright.

## Konfigurasi

```env
ADUANKONTEN_BASE_URL=https://aduankonten.id
ADUANKONTEN_SESSION_PATH=./.aduankonten_session.json
ADUANKONTEN_USER_DATA_DIR=./.aduankonten_profile
ADUANKONTEN_DEBUG_DIR=
ADUANKONTEN_USER_AGENT=
ADUANKONTEN_BROWSER_CHANNEL=
ADUANKONTEN_CHECK_INTERVAL_HOURS=6

CLOUDFLARE_CAPTCHA_SOLVER=true
CLOUDFLARE_CAPTCHA_PROVIDER=openrouter
CLOUDFLARE_GEMINI_API_KEY=
CLOUDFLARE_GEMINI_MODEL=gemini-flash-lite-latest
CLOUDFLARE_OPENROUTER_API_KEY=
CLOUDFLARE_OPENROUTER_MODEL=google/gemini-flash-1.5
CLOUDFLARE_CAPTCHA_MAX_RETRIES=3
CLOUDFLARE_CAPTCHA_TIMEOUT_MS=60000
```

Catatan:

- `ADUANKONTEN_BROWSER_CHANNEL=chrome` dapat dipakai jika Patchright tidak menemukan browser default.
- `ADUANKONTEN_USER_AGENT` dikosongkan secara default. Isi hanya jika perlu menyamakan environment browser tertentu.
- `CLOUDFLARE_CAPTCHA_SOLVER` adalah handler best-effort untuk mode headless. Jika Cloudflare tetap memberi challenge berulang, gunakan warmup/headed.

## Flow Submit

1. Pesan WhatsApp masuk ke `src/wa/bot.js`.
2. `handleLaporKonten()` mendeteksi intent laporan konten.
3. Handler mengekstrak:
   - `url`
   - `categoryKey`
   - `reason`
4. Bot meminta konfirmasi.
5. Setelah user membalas `Ya`, record disimpan ke `laporan_layanan`:
   - `portal_target = 'aduankonten'`
   - `lokasi_detail = url`
   - `kategori = aduankonten:<kategori>`
6. `submitAduanKonten()` menjalankan browser.
7. Search URL di halaman utama:
   - isi `#search_url`
   - klik `#btn-search-submit`
   - baca `POST /livewire/update`
8. Jika duplicate, ambil link dukungan `/auth/redirect/<id>` dan return duplicate.
9. Jika bisa submit, buka `/submission/submit-form`.
10. Isi form:
   - `#category_id`
   - `#reason`
   - `#multiplefileupload`
11. Klik `#btn-submission`.
12. Validasi response submit dan ambil kode laporan.
13. DB diupdate menjadi `submitted`, `duplicate`, atau `failed`.

## Validasi Sukses

Berdasarkan dump `aduankontenid.txt`, submit yang berhasil mengirim:

```text
POST https://aduankonten.id/submission/submit
```

Sukses normal:

```text
HTTP 302
Location: https://aduankonten.id/page/success
```

Halaman `/page/success` memuat `#submissionSuccessModal` dan kode laporan di `#kodeLaporan`. Contoh dari dump:

```text
submissionNumber.innerText = 'PH7TVS4'
```

Kode tidak boleh menganggap sukses hanya karena tombol submit berhasil diklik. Sukses harus dibuktikan oleh redirect `/page/success` dan kode laporan yang terbaca.

## Headless dan Headed

Headless dipakai untuk flow otomatis. Namun `aduankonten.id` dapat memberi Cloudflare challenge berulang pada mode headless walaupun `cf_clearance` sudah ada.

Alur yang disarankan:

1. Jalankan warmup/probe headless.
2. Jika form search muncul, lanjut probe atau submit.
3. Jika Cloudflare challenge berulang, jalankan warmup headed:

```bash
npm run warmup:aduankonten -- --debug --wait-ms=300000
```

4. Setelah session tersimpan, coba ulang probe/submit.
5. Jika headless tetap re-challenge, gunakan `--headed` untuk submit produksi.

## Kategori

| Key | ID | Label |
| --- | --- | --- |
| `pornografi` | `1` | Pornografi |
| `perjudian` | `2` | Perjudian |
| `pencemaran` | `3` | Fitnah/Pencemaran Nama Baik |
| `penipuan` | `4` | Penipuan |
| `sara` | `5` | SARA |
| `kekerasan` | `6` | Kekerasan/Kekerasan Pada Anak |
| `produk_khusus` | `7` | Perdagangan Produk dengan aturan khusus |
| `terorisme` | `8` | Terorisme/Radikalisme |
| `separatisme` | `9` | Separatisme/Organisasi Berbahaya |
| `hki` | `10` | Hak Kekayaan Intelektual |
| `keamanan_informasi` | `11` | Pelanggaran Keamanan Informasi |
| `rekomendasi_sektor` | `12` | Konten Negatif yang Direkomendasikan Instansi Sektor |
| `sosial_budaya` | `13` | Konten yang Melanggar Nilai Sosial dan Budaya |
| `hoaks` | `14` | Berita Bohong/HOAKS |
| `pemerasan` | `15` | Pemerasan |

Tanpa LLM, kategori ditentukan dengan heuristik keyword. Jika LLM aktif, hasilnya tetap dibatasi ke daftar kategori di atas.

## Checker

`src/agent2/aduankonten-checker.js` mengecek laporan dengan:

- `portal_target = 'aduankonten'`
- `status = 'submitted'`
- `nomor_ticket` terisi

Checker membuka form lacak AduanKonten, submit kode laporan, parse status yang tersedia, lalu mengirim notifikasi WhatsApp jika fingerprint status berubah.

## Batasan

- `--submit` mengirim laporan produksi resmi. Jangan gunakan dengan URL dummy.
- Cloudflare/reCAPTCHA bisa membuat headless gagal walaupun solver melaporkan cookie sudah ada.
- `--debug` menyimpan HTML dan screenshot ke `debug/aduankonten/`.
- Jika field alasan terseleksi biru atau tidak terisi, pastikan flow memakai helper target-scoped `humanFill()` terbaru.
- Jika submit tidak sukses, cek log `response submit`. Sukses normal adalah `HTTP 302 -> /page/success`.
