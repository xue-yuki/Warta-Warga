# AduanKonten Usage dan Demo

Dokumen ini berisi cara menjalankan dry-run, warmup, probe, live submit, dan checker AduanKonten.

## Prasyarat

Install dependency:

```bash
npm install
```

Pastikan Chromium/Chrome tersedia. Jalur AduanKonten memakai Patchright dan `ghost-cursor`.

Konfigurasi minimal:

```env
ADUANKONTEN_BASE_URL=https://aduankonten.id
ADUANKONTEN_SESSION_PATH=./.aduankonten_session.json
ADUANKONTEN_USER_DATA_DIR=./.aduankonten_profile
ADUANKONTEN_DEBUG_DIR=
ADUANKONTEN_BROWSER_CHANNEL=
ADUANKONTEN_CHECK_INTERVAL_HOURS=6
```

Jika browser tidak ditemukan:

```env
ADUANKONTEN_BROWSER_CHANNEL=chrome
```

Opsional untuk headless challenge handler:

```env
CLOUDFLARE_CAPTCHA_SOLVER=true
CLOUDFLARE_CAPTCHA_PROVIDER=openrouter
CLOUDFLARE_OPENROUTER_API_KEY=
CLOUDFLARE_OPENROUTER_MODEL=google/gemini-flash-1.5
```

Atau Gemini langsung:

```env
CLOUDFLARE_CAPTCHA_PROVIDER=gemini
CLOUDFLARE_GEMINI_API_KEY=
CLOUDFLARE_GEMINI_MODEL=gemini-flash-lite-latest
```

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

Warmup membuat atau menyegarkan session browser.

Headless:

```bash
npm run warmup:aduankonten -- --headless --debug
```

Headed:

```bash
npm run warmup:aduankonten -- --debug --wait-ms=300000
```

Gunakan headed jika headless terus mendapat Cloudflare challenge berulang.

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

Submit sukses jika:

```text
POST /submission/submit
HTTP 302
Location: https://aduankonten.id/page/success
```

Lalu halaman sukses memuat kode laporan di `#kodeLaporan`.

Log debug normal:

```text
[aduankonten] mengklik submit
[aduankonten] response submit: HTTP 302 -> https://aduankonten.id/page/success
[aduankonten] menunggu halaman sukses
```

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

Matikan hanya AduanKonten:

```env
ADUANKONTEN_CHECK_INTERVAL_HOURS=0
```

## Troubleshooting

- Jika muncul challenge berulang di headless, jalankan headed.
- Jika `POST /livewire/update` mendapat `HTTP 403 Just a moment`, session masih ditahan Cloudflare.
- Jika field alasan terseleksi biru atau tidak terisi, pastikan `src/portal/aduankonten.js` memakai `humanFill()` versi terbaru.
- Jika submit terlihat klik tapi tidak sukses, cek log `response submit`.
- Jika Patchright tidak menemukan browser, set `ADUANKONTEN_BROWSER_CHANNEL=chrome`.
- Jika debug aktif, cek HTML/screenshot di `debug/aduankonten/`.
