/**
 * Thin HTTP wrapper over respondToMessage — HANYA untuk load testing k6.
 * Jalankan SEBELUM k6: node scripts/load-test-server.js
 *
 * POST /chat
 *   body: { text, konteks?, scopeTags?, wilayahTag?, sessionId? }
 *   200:  { reply, jenis, aksi, label, grounded, latencyMs }
 *
 * GET /health
 *   200: { ok: true, chunks }
 */

import express from 'express';
import { initDb, countChunks } from '../src/db/index.js';
import { respondToMessage } from '../src/agent2/handler.js';
import { groupScopeTags } from '../src/util/wilayah.js';

const PORT = process.env.LOAD_TEST_PORT || 3099;

// Preset scope grup Banyumas (sama seperti demo.js)
const grupBanyumas = { wilayah_tag: 'kabupaten:banyumas', provinsi_tag: 'provinsi:jawa_tengah' };
const SCOPE_BANYUMAS = groupScopeTags(grupBanyumas);

const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  const chunks = await countChunks().catch(() => -1);
  res.json({ ok: true, chunks });
});

app.post('/chat', async (req, res) => {
  const { text, konteks = 'japri', scopeTags = null, wilayahTag = null, sessionId = null } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'field "text" wajib diisi (string)' });
  }

  const t0 = Date.now();
  try {
    const result = await respondToMessage({ text, konteks, scopeTags, wilayahTag, sessionId });
    res.json({ ...result, latencyMs: Date.now() - t0 });
  } catch (err) {
    res.status(500).json({ error: err.message, latencyMs: Date.now() - t0 });
  }
});

// Sediakan preset scope Banyumas agar k6 tidak perlu menghitung sendiri
app.get('/presets', (_req, res) => {
  res.json({ scopeBanyumas: SCOPE_BANYUMAS });
});

async function main() {
  await initDb();
  const chunks = await countChunks();
  if (chunks === 0) {
    console.warn('⚠️  KB kosong — jalankan `npm run seed` dulu agar jawaban bermakna.');
  }
  app.listen(PORT, () => {
    console.log(`✅ Load-test server siap di http://localhost:${PORT}`);
    console.log(`   KB: ${chunks} chunk`);
    console.log(`   Endpoint: POST /chat  |  GET /health  |  GET /presets`);
  });
}

main().catch((e) => {
  console.error('Gagal start:', e);
  process.exit(1);
});
