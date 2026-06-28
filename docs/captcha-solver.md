# CAPTCHA dan Challenge Handler

Dokumen ini merangkum konfigurasi solver yang dipakai project.

## LaporGub OCR CAPTCHA

Flow LaporGub memakai OCR untuk CAPTCHA gambar sederhana.

Konfigurasi:

```env
CAPTCHA_SOLVER_PROVIDER=auto
VISION_API_KEY=
VISION_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
VISION_MODEL=gemini-flash-lite-latest
CAPTCHA_GEMINI_API_KEY=
CAPTCHA_GEMINI_MODEL=
CAPTCHA_OPENROUTER_API_KEY=
CAPTCHA_OPENROUTER_MODEL=
CAPTCHA_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

Provider:

- `auto`: coba Gemini lalu OpenRouter.
- `gemini`: gunakan Gemini/OpenAI-compatible vision.
- `openrouter`: gunakan OpenRouter vision.

Kode terkait:

- `src/agent2/captcha.js`
- `src/portal/laporgub.js`

## AduanKonten Cloudflare Challenge Handler

Flow AduanKonten memiliki handler best-effort untuk mode headless.

Konfigurasi:

```env
CLOUDFLARE_CAPTCHA_SOLVER=true
CLOUDFLARE_CAPTCHA_PROVIDER=openrouter
CLOUDFLARE_GEMINI_API_KEY=
CLOUDFLARE_GEMINI_MODEL=gemini-flash-lite-latest
CLOUDFLARE_OPENROUTER_API_KEY=
CLOUDFLARE_OPENROUTER_MODEL=google/gemini-flash-1.5
CLOUDFLARE_CAPTCHA_MAX_RETRIES=3
CLOUDFLARE_CAPTCHA_TIMEOUT_MS=60000
```

Provider:

- `gemini`: gunakan Gemini API dari AI Studio.
- `openrouter`: gunakan model vision lewat OpenRouter.

Kode terkait:

- `src/agent2/cloudflare-captcha-solver.js`
- `src/portal/aduankonten.js`

## Catatan Operasional

- AduanKonten tetap dapat memberi challenge berulang pada mode headless walaupun cookie `cf_clearance` sudah ada.
- Jika challenge berulang, gunakan warmup atau submit dengan `--headed`.
- `ghost-cursor` dipakai untuk interaksi mouse/form, bukan untuk menggantikan session browser yang valid.
- Simpan session AduanKonten melalui `.aduankonten_profile/` dan `.aduankonten_session.json`.
