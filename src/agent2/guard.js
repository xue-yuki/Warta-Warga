// Pertahanan prompt-injection & anti off-topic untuk Warta Warga (defense in depth).
// Prinsip: tangkap manipulasi SECARA DETERMINISTIK (regex) SEBELUM teks sampai ke LLM,
// supaya tidak bisa "dibujuk" untuk mengabaikan instruksi / ganti peran. Plus output guard
// sebagai jaring pengaman terakhir (bot ini tidak pernah sah mengeluarkan kode/konten off-topic).

// --- LAPIS 1: pola manipulasi instruksi / pergantian peran / identitas model. ---
const INJECTION_PATTERNS = [
  /\babaikan\b[\s\S]{0,40}\b(instruksi|perintah|aturan|prompt|arahan|sebelum|di ?atas)/i,
  /\blupakan\b[\s\S]{0,40}\b(instruksi|perintah|aturan|prompt|arahan|semua|sebelum)/i,
  /\b(ignore|disregard|forget|override|bypass)\b[\s\S]{0,40}\b(instruction|instructions|prompt|rule|rules|previous|above|prior|guideline|guidelines|system)/i,
  /\b(berperan sebagai|berpura-?pura|pura-?pura (jadi|menjadi)|anggap (kamu|dirimu|kau)|bayangkan (kamu|kau)|jadilah|seolah(-| )olah kamu)\b/i,
  /\b(act as|pretend (to be|you)|you are now|you'?re now|roleplay|role-?play|imagine you are|simulate (a|an|being))\b/i,
  /\bkamu\b[\s\S]{0,40}\b(chatgpt|gpt-?\d?|deepseek|gemini|claude|bard|llama|copilot|language model|ai model|model (bahasa|ai))\b/i,
  /\b(developer mode|jailbreak|jail-?break|dan mode|do anything now|mode pengembang|tanpa (batasan|filter|sensor|aturan|larangan))\b/i,
  /\b(system prompt|prompt sistem|instruksi sistem|prompt (kamu|awal|asli|mu)|initial prompt)\b/i,
];

/** True bila pesan berisi upaya manipulasi instruksi/peran. */
export function isInjection(text) {
  const t = String(text || '');
  return INJECTION_PATTERNS.some((re) => re.test(t));
}

// --- LAPIS 2: permintaan TUGAS di luar topik bansos (kode, terjemah, karya tulis, resep). ---
const OFFTOPIC_TASK_PATTERNS = [
  // Minta dibuatkan kode/program.
  /\b(buat(kan|in)?|bikin(kan|in)?|tulis(kan|in)?|generate|write|kasih(kan|in)?|contoh|bantu (buat|bikin))\b[\s\S]{0,40}\b(kode|koding|coding|program|script|skrip|fungsi|function|algoritma|python|javascript|java\b|c\+\+|c#|html|css|sql|php|kotlin|golang|aplikasi|website)\b/i,
  /\bformat\s+(code|kode|pemrograman)\b/i,
  /\bbahasa\s+(pemrograman|python|java\b|javascript|c\b)\b/i,
  // Terjemahan.
  /\b(terjemah(kan|in)?|translate|artikan ke bahasa|alih ?bahasa)\b/i,
  // Karya tulis / kreatif.
  /\b(buat(kan|in)?|tulis(kan|in)?|bikin(kan|in)?|cerita(kan)?|karang(kan|in)?|susun(kan|in)?)\b[\s\S]{0,40}\b(puisi|sajak|esai|essay|cerpen|cerita|dongeng|kisah|novel|lagu|lirik|pantun|artikel|makalah|skripsi|naskah|pidato)\b/i,
  // Resep / masakan.
  /\b(resep|cara (masak|memasak|membuat (kue|makanan|nasi|mie))|masakan)\b/i,
];

/** True bila pesan meminta tugas di luar lingkup info bansos. */
export function isOffTopicTask(text) {
  return OFFTOPIC_TASK_PATTERNS.some((re) => re.test(String(text || '')));
}

// Jawaban tetap (tidak digenerate LLM → tidak bisa di-override oleh isi pesan).
export const REFUSAL_REPLY =
  'Maaf ya, aku khusus *asisten info bansos & waspada penipuan* 🙏 ' +
  'Aku nggak bisa ganti peran atau ngerjain hal di luar itu (nulis kode, esai, terjemahan, dll). ' +
  'Tapi soal bansos atau kabar yang kamu ragukan — aku siap bantu! 😊';

// --- LAPIS 4 (output guard): balasan TIDAK BOLEH mengandung kode. ---
const CODE_SIGNALS = [/```/, /\bdef\s+\w+\s*\(/, /\bprint\s*\(/, /console\.log/, /<\/[a-z][\w-]*>/i, /\bimport\s+\w+/, /\bpublic\s+static\b/];

/** True bila teks balasan tampak mengandung kode (Warta Warga tak pernah sah mengeluarkan kode). */
export function looksLikeCode(text) {
  const t = String(text || '');
  return CODE_SIGNALS.some((re) => re.test(t));
}
