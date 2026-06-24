// Tes percakapan MENGALIR (agentic) — TANPA WhatsApp. History nyambung via sessionId tetap.
// Jalankan: node scripts/test-brain.js
import { respondToMessage } from '../src/agent2/handler.js';
import { hasLLM } from '../src/config.js';

// Tiap "percakapan" = urutan giliran dengan satu sessionId (history menumpuk).
const PERCAKAPAN = [
  {
    nama: 'Konteks JNT (yang tadi ngaco) — harus nyambung',
    sid: 'p1',
    giliran: [
      'kak',
      'eum kamu wibu ya',
      'iya kemarin aku di chat sama pihak jnt',
      'itu gmn ya',
      'oh gitu, makasih ya',
    ],
  },
  {
    nama: 'Ngalir random + lapor (LLM nyetir, no template)',
    sid: 'p2',
    giliran: [
      'halo bang lagi rame penipuan apa sih sekarang',
      'tadi ada yg telpon ngaku dari bank minta kode otp',
      'di kab bekasi',
    ],
  },
  {
    nama: 'Info bansos + follow-up kontekstual',
    sid: 'p3',
    giliran: ['syarat pkh apa aja', 'kalo buat anak sekolah dapet juga ga', 'makasih kak'],
  },
];

const run = async () => {
  if (!hasLLM()) {
    console.log('⚠️  LLM tidak aktif — tes butuh LLM. Stop.');
    return;
  }
  for (const c of PERCAKAPAN) {
    console.log('\n' + '═'.repeat(74));
    console.log('💬 ' + c.nama);
    console.log('═'.repeat(74));
    for (const text of c.giliran) {
      const r = await respondToMessage({ text, konteks: 'japri', scopeTags: null, wilayahTag: null, sessionId: c.sid });
      console.log(`\n🧑 ${text}`);
      console.log(`🤖 [${r.aksi}] ${r.reply ? r.reply.replace(/\n/g, '\n   ') : '(tidak balas)'}`);
    }
  }
  console.log('\n' + '═'.repeat(74));
};

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
