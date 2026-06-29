# AduanKonten Usage dan Demo

Dokumen ini berisi cara menjalankan dry-run, warmup, probe, live submit, dan checker AduanKonten.

## Prasyarat

Install dependency Node dan Python:

```bash
npm install
npm run setup:aduankonten
```

`npm run setup:aduankonten` menjalankan `python -m pip install -r requirements.txt`.

Pastikan Chrome/Chromium tersedia. Jalur AduanKonten memakai SeleniumBase UC mode dari Python.

Konfigurasi minimal:

```env
ADUANKONTEN_BASE_URL=https://aduankonten.id
ADUANKONTEN_SESSION_PATH=./.aduankonten_session.json
ADUANKONTEN_USER_DATA_DIR=./.aduankonten_profile
ADUANKONTEN_DEBUG_DIR=
ADUANKONTEN_PYTHON=python
ADUANKONTEN_SELENIUMBASE_SCRIPT=./scripts/aduankonten_seleniumbase.py
ADUANKONTEN_CHECK_INTERVAL_HOURS=6
```

Jika Python berbeda, isi `ADUANKONTEN_PYTHON=py -3` atau path Python yang punya package SeleniumBase.

Checklist setelah setup:

```bash
python -c "import seleniumbase; print(seleniumbase.__version__)"
npm run warmup:aduankonten -- --headless --debug --wait-ms=300000
npm run demo:aduankonten -- --probe --url=https://example.com --category=perjudian --debug --challenge-wait-ms=300000
```

Bot WhatsApp memakai `headless: true` untuk submit dan follow-up status AduanKonten. Flag `--headed` hanya untuk debugging manual dari script CLI.

## Dry Run WhatsApp Flow

Dry-run hanya menguji intent, parsing, dan teks konfirmasi. Tidak mengirim laporan produksi.

```bash
npm run demo:aduankonten
```

Custom URL:

```bash
npm run demo:aduankonten -- --url=https://example.test --text="tolong laporkan situs judi https://example.test"
```

## Warmup Session

Warmup membuat atau menyegarkan profile SeleniumBase/Chrome.

Headless:

```bash
npm run warmup:aduankonten -- --headless --debug
```

Headed:

```bash
npm run warmup:aduankonten -- --debug --wait-ms=300000
```

Bot WhatsApp memakai headless. Gunakan headed hanya untuk debugging manual jika Cloudflare tetap re-challenge.

Hasil warmup sukses akan menyimpan:

- `.aduankonten_profile/`
- `.aduankonten_session.json`

## Probe Search

Probe berhenti setelah tahap search URL. Ini aman untuk cek apakah portal memberi outcome `submit_form` atau `duplicate`.

```bash
npm run demo:aduankonten -- --probe --url=https://target.example --category=perjudian --debug --challenge-wait-ms=300000
```

Jika headless gagal:

```bash
npm run demo:aduankonten -- --probe --url=https://target.example --category=perjudian --headed --debug --challenge-wait-ms=300000
```

Output sukses probe:

```json
{
  "success": true,
  "url": "https://target.example",
  "kind": "submit_form"
}
```

Jika konten sudah pernah dilaporkan, output memakai `kind: "duplicate"`.

## Live Submit

Gunakan hanya untuk URL yang benar-benar akan dilaporkan.

Headless:

```bash
npm run demo:aduankonten -- --submit --url=https://target.example --category=perjudian --reason="Website ini diduga memuat promosi atau layanan perjudian online yang dapat diakses publik." --debug --challenge-wait-ms=300000
```

Headed fallback:

```bash
npm run demo:aduankonten -- --submit --url=https://target.example --category=perjudian --reason="Website ini diduga memuat promosi atau layanan perjudian online yang dapat diakses publik." --headed --debug --challenge-wait-ms=300000
```

Dengan lampiran manual:

```bash
npm run demo:aduankonten -- --submit --url=https://target.example --category=penipuan --reason="Website ini diduga digunakan untuk phishing dan mengambil data pengguna." --attachment=C:\path\to\screenshot.png --debug
```

Jika `--attachment` tidak diberikan, script memakai screenshot preview/page sebagai lampiran.

## Validasi Sukses

Submit sukses jika halaman akhir menuju:

```text
https://aduankonten.id/page/success
```

Lalu halaman sukses memuat kode laporan di `#kodeLaporan`.

Output submit sukses:

```json
{
  "success": true,
  "duplicate": false,
  "ticketNumber": "PH7TVS4",
  "url": "https://target.example"
}
```

## Checker Manual

Cek semua laporan yang sudah `submitted`:

```bash
npm run check:aduankonten
```

Cek satu tiket:

```bash
npm run check:aduankonten -- --ticket PH7TVS4
```

Output JSON:

```bash
npm run check:aduankonten -- --ticket PH7TVS4 --json
```

## Scheduler

Scheduler berjalan saat WhatsApp bot terhubung.

Master switch:

```env
AGENT2_LAYANAN_CHECKERS_ENABLED=true
```

Secara default, AduanKonten tidak langsung dicek saat `npm start` agar bot baru connect tidak langsung memicu status check/Cloudflare. Cek pertama berjalan pada interval berikutnya.

```env
ADUANKONTEN_CHECK_ON_BOOT=false
ADUANKONTEN_CHECK_INTERVAL_HOURS=6
```

Jika memang ingin langsung cek status saat startup:

```env
ADUANKONTEN_CHECK_ON_BOOT=true
```

Matikan hanya AduanKonten:

```env
ADUANKONTEN_CHECK_INTERVAL_HOURS=0
```

## Troubleshooting

- Jika muncul challenge berulang di headless, jalankan headed.
- Jika SeleniumBase belum terinstall, jalankan `npm run setup:aduankonten`.
- Jika Python tidak ditemukan, set `ADUANKONTEN_PYTHON`.
- Jika submit terlihat klik tapi tidak sukses, cek HTML/screenshot debug.
- Jika debug aktif, cek HTML/screenshot di `debug/aduankonten/`.
