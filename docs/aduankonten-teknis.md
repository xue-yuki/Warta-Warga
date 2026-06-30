# AduanKonten Agent 2 - Teknis

Dokumen ini menjelaskan integrasi laporan konten negatif ke `aduankonten.id` dari Agent 2 Warta Warga.

## Tujuan

Fitur AduanKonten membantu warga mengirim laporan konten negatif dari WhatsApp tanpa perlu mengisi form portal secara manual. Bot menyiapkan URL, kategori, alasan, lampiran, submit, lalu menyimpan kode laporan untuk tracking.

Komponen utama:

- `src/agent2/lapor-konten.js`: intent, parsing URL/kategori/alasan, konfirmasi user, dan pencatatan DB.
- `src/portal/aduankonten.js`: wrapper Node untuk otomasi AduanKonten.
- `scripts/aduankonten_seleniumbase.py`: driver browser SeleniumBase UC mode untuk Cloudflare/search/submit/status.
- `src/agent2/aduankonten-checker.js`: polling status tiket dan notifikasi WhatsApp.
- `src/agent2/layanan-checker.js`: scheduler layanan Agent 2 untuk LaporGub dan AduanKonten.
- `scripts/demo-aduankonten.js`: dry-run, probe, dan live submit manual.
- `scripts/warmup-aduankonten.js`: membuat/menyegarkan session browser.

## Runtime Browser

Jalur AduanKonten memakai:

- `seleniumbase` UC mode untuk browser automation dan challenge Cloudflare best-effort.
- Python driver `scripts/aduankonten_seleniumbase.py`.
- Persistent profile `ADUANKONTEN_USER_DATA_DIR`.
- Storage state `ADUANKONTEN_SESSION_PATH`.

`playwright-core` masih ada di project untuk modul lain seperti LaporGub/BrightData, tetapi portal AduanKonten memakai SeleniumBase.

## Konfigurasi

```env
ADUANKONTEN_BASE_URL=https://aduankonten.id
ADUANKONTEN_SESSION_PATH=./.aduankonten_session.json
ADUANKONTEN_USER_DATA_DIR=./.aduankonten_profile
ADUANKONTEN_DEBUG_DIR=
ADUANKONTEN_USER_AGENT=
ADUANKONTEN_PYTHON=python
ADUANKONTEN_SELENIUMBASE_SCRIPT=./scripts/aduankonten_seleniumbase.py
ADUANKONTEN_CHECK_INTERVAL_HOURS=6
```

Catatan:

- Jalankan `npm run setup:aduankonten` sekali untuk memasang dependency Python.
- Command setup tersebut membaca `requirements.txt` dan memasang `seleniumbase`.
- `ADUANKONTEN_PYTHON` dapat diisi `python`, `py -3`, atau path Python yang punya SeleniumBase.
- `ADUANKONTEN_USER_AGENT` dikosongkan secara default. Isi hanya jika perlu menyamakan environment browser tertentu.
- SeleniumBase UC mode menangani Cloudflare secara best-effort. Jika Cloudflare tetap memberi challenge berulang, gunakan warmup/headed untuk debugging manual.

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
   - tunggu outcome halaman `submit_form` atau duplicate
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

Flow AduanKonten dari WhatsApp memakai SeleniumBase mode headless. Mode headed tetap tersedia di script CLI untuk warmup/debugging manual ketika Cloudflare memberi challenge berulang.

Alur yang disarankan:

1. Jalankan setup Python:

```bash
npm run setup:aduankonten
```

Validasi SeleniumBase tersedia:

```bash
python -c "import seleniumbase; print(seleniumbase.__version__)"
```

2. Jalankan warmup headless:

```bash
npm run warmup:aduankonten -- --headless --debug --wait-ms=300000
```

3. Jika Cloudflare masih berulang, jalankan warmup headed untuk debugging manual:

```bash
npm run warmup:aduankonten -- --debug --wait-ms=300000
```

4. Setelah session tersimpan, coba probe/submit. Bot WhatsApp tetap memanggil AduanKonten dengan `headless: true`.

```bash
npm run demo:aduankonten -- --probe --url=https://example.com --category=perjudian --debug --challenge-wait-ms=300000
```

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

Saat bot WhatsApp baru connect, scheduler hanya didaftarkan. AduanKonten tidak langsung dibuka kecuali `ADUANKONTEN_CHECK_ON_BOOT=true`. Default ini sengaja dipakai agar proses baru start tidak langsung memicu Cloudflare/status check.

## Batasan

- `--submit` mengirim laporan produksi resmi. Jangan gunakan dengan URL dummy.
- Cloudflare/reCAPTCHA bisa membuat headless gagal walaupun session browser sudah ada.
- `--debug` menyimpan HTML dan screenshot ke `debug/aduankonten/`.
- Jika submit tidak sukses, cek HTML/screenshot debug. Sukses normal tetap halaman `/page/success` dengan kode laporan.
