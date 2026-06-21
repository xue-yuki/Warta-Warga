// Memori percakapan JANGKA PENDEK & EFEMERAL (hanya di RAM).
// Tujuan: follow-up dalam satu obrolan tetap nyambung.
// Privasi (PRD §3.4/§3.5): TIDAK pernah ditulis ke DB/disk, ada TTL, hilang saat restart.
// Ini bukan "database warga" — sekadar konteks chat sesaat, seperti ingatan ngobrol biasa.

const store = new Map(); // jid -> { turns: [{role, content}], ts }
const MAX_TURNS = 12; // ~6 pasang tanya-jawab terakhir
const TTL_MS = 30 * 60 * 1000; // 30 menit

function fresh(entry) {
  return entry && Date.now() - entry.ts <= TTL_MS;
}

/** Ambil riwayat giliran terakhir (kosong bila kedaluwarsa/tidak ada). */
export function getHistory(jid) {
  if (!jid) return [];
  const e = store.get(jid);
  if (!fresh(e)) {
    store.delete(jid);
    return [];
  }
  return e.turns;
}

/** Catat satu giliran (role: 'user' | 'assistant'). */
export function pushTurn(jid, role, content) {
  if (!jid || !content) return;
  let e = store.get(jid);
  if (!fresh(e)) e = { turns: [], ts: Date.now() };
  e.turns.push({ role, content });
  if (e.turns.length > MAX_TURNS) e.turns = e.turns.slice(-MAX_TURNS);
  e.ts = Date.now();
  store.set(jid, e);
}

export function clearHistory(jid) {
  store.delete(jid);
}
