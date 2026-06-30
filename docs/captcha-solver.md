# CAPTCHA dan Challenge Handler

Dokumen ini merangkum konfigurasi solver yang dipakai project.

## LaporGub OCR CAPTCHA

Flow LaporGub memakai OCR untuk CAPTCHA gambar sederhana.

Konfigurasi:

```env
CAPTCHA_SOLVER_API_KEY=
CAPTCHA_SOLVER_BASE_URL=
CAPTCHA_SOLVER_MODEL=
VISION_API_KEY=
VISION_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
VISION_MODEL=gemini-flash-lite-latest
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

Urutan konfigurasi:

- Jika `CAPTCHA_SOLVER_API_KEY` diisi, solver memakai key khusus itu.
- Jika tidak, solver memakai `VISION_API_KEY`.
- Jika keduanya kosong, solver fallback ke `OPENROUTER_API_KEY`.
- `CAPTCHA_SOLVER_BASE_URL` dan `CAPTCHA_SOLVER_MODEL` boleh dipakai untuk override khusus captcha tanpa mengubah LLM utama bot.

Kode terkait:

- `src/agent2/captcha.js`
- `src/portal/laporgub.js`

## AduanKonten Cloudflare Challenge Handler

Flow AduanKonten memakai SeleniumBase UC mode dari Python. Handler ini menjadi satu jalur browser untuk portal AduanKonten.

Konfigurasi:

```env
ADUANKONTEN_PYTHON=python
ADUANKONTEN_SELENIUMBASE_SCRIPT=./scripts/aduankonten_seleniumbase.py
ADUANKONTEN_USER_DATA_DIR=./.aduankonten_profile
```

Install dependency Python:

```bash
npm run setup:aduankonten
```

Validasi cepat:

```bash
python -c "import seleniumbase; print(seleniumbase.__version__)"
npm run warmup:aduankonten -- --headless --debug --wait-ms=300000
```

Kode terkait:

- `src/portal/aduankonten.js`
- `scripts/aduankonten_seleniumbase.py`

## Catatan Operasional

- AduanKonten tetap dapat memberi challenge berulang pada mode headless walaupun profile browser sudah ada.
- Jika challenge berulang, gunakan warmup headed untuk debugging manual.
- Simpan session AduanKonten melalui `.aduankonten_profile/` dan `.aduankonten_session.json`.
