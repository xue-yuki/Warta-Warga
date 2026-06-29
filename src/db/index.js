// Lapisan persistensi Warta Warga — interface ASYNC dengan DUA backend:
//   - SQLite (better-sqlite3) bila SUPABASE_DB_URL kosong → dev/offline & tes cepat.
//   - Postgres (Supabase) bila SUPABASE_DB_URL diset → deploy.
// Semua fungsi async (Postgres async); SQLite tetap sinkron di dalam, dibungkus async agar seragam.
// Shape baris dijaga identik: id=number (SERIAL int4), timestamp=ISO string (TEXT), syarat/embedding=array.

import Database from "better-sqlite3";
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, hasSupabase } from "../config.js";
import { embed, cosine } from "../embeddings/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Inisialisasi backend ----------
let _sqlite = null;
let _pg = null;
let _pgReady = null;

function sqliteDb() {
  if (_sqlite) return _sqlite;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _sqlite = new Database(config.dbPath);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');
  _sqlite.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  ensureColumn(_sqlite, 'info_bansos', 'batas_daftar', 'TEXT');
  ensureColumn(_sqlite, 'info_bansos', 'image_id', 'TEXT');
  ensureColumn(_sqlite, 'info_bansos', 'image_path', 'TEXT');
  ensureColumn(_sqlite, 'kb_chunks', 'batas_daftar', 'TEXT');
  ensureColumn(_sqlite, 'log_interaksi', 'aksi', 'TEXT');
  ensureColumn(_sqlite, 'log_interaksi', 'ringkas_pesan', 'TEXT');
  ensureColumn(_sqlite, 'log_interaksi', 'ringkas_resp', 'TEXT');
  ensureColumn(_sqlite, 'laporan_layanan', 'last_status_notified_at', 'TEXT');
  ensureColumn(_sqlite, 'laporan', 'sumber_urls', 'TEXT');
  ensureColumn(_sqlite, 'laporan', 'embedding', 'TEXT');
  ensureColumn(_sqlite, 'laporan', 'cluster_reason', 'TEXT');
  return _sqlite;
}

function ensureColumn(db, table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

async function pgInit() {
  // prepare:false → aman untuk Supabase pooler (transaction mode tak dukung prepared statement).
  _pg = postgres(config.supabase.dbUrl, { ssl: "require", prepare: false, max: 5, idle_timeout: 20, onnotice: () => {} });
  const ddl = fs.readFileSync(path.join(__dirname, "schema.pg.sql"), "utf8");
  await _pg.unsafe(ddl); // idempoten (CREATE IF NOT EXISTS)
  try {
    await _pg`ALTER TABLE info_bansos ADD COLUMN IF NOT EXISTS image_id TEXT`;
    await _pg`ALTER TABLE info_bansos ADD COLUMN IF NOT EXISTS image_path TEXT`;
  } catch (err) {
    /* ignore if column exists or alter not supported */
  }
  try {
    await _pg`ALTER TABLE info_bansos ADD COLUMN IF NOT EXISTS image_path TEXT`;
  } catch (err) {
    /* ignore if column exists or alter not supported */
  }
  try {
    await _pg`ALTER TABLE laporan_layanan ADD COLUMN IF NOT EXISTS last_status_notified_at TEXT`;
  } catch (err) {
    /* ignore if column exists or alter not supported */
  }
  try {
    await _pg`ALTER TABLE laporan ADD COLUMN IF NOT EXISTS sumber_urls TEXT`;
  } catch (err) {
    /* ignore if column exists or alter not supported */
  }
  try {
    await _pg`ALTER TABLE laporan ADD COLUMN IF NOT EXISTS embedding JSONB`;
  } catch (err) {
    /* ignore if column exists or alter not supported */
  }
  try {
    await _pg`ALTER TABLE laporan ADD COLUMN IF NOT EXISTS cluster_reason TEXT`;
  } catch (err) {
    /* ignore if column exists or alter not supported */
  }
  return _pg;
}

/** Pastikan backend siap. Untuk Postgres: konek + jalankan skema idempoten (sekali). */
export async function initDb() {
  if (!hasSupabase()) {
    sqliteDb();
    await _seedTablesIfEmpty();
    return;
  }
  if (!_pgReady) _pgReady = pgInit();
  await _pgReady;
  await _seedTablesIfEmpty();
}

/** Seed sources_whitelist & sumber_crawl dari JSON jika tabel masih kosong (migrasi awal). */
async function _seedTablesIfEmpty() {
  const wlCount = hasSupabase()
    ? (await _pg`SELECT COUNT(*)::int AS n FROM sources_whitelist`)[0].n
    : sq().prepare('SELECT COUNT(*) AS n FROM sources_whitelist').get().n;
  if (wlCount === 0) {
    const wlPath = path.join(__dirname, '../../data/sources_whitelist.json');
    if (fs.existsSync(wlPath)) {
      const { allowedHostPatterns = [] } = JSON.parse(fs.readFileSync(wlPath, 'utf8'));
      for (const p of allowedHostPatterns) {
        if (hasSupabase()) await _pg`INSERT INTO sources_whitelist (pattern) VALUES (${p}) ON CONFLICT (pattern) DO NOTHING`;
        else sq().prepare('INSERT OR IGNORE INTO sources_whitelist (pattern) VALUES (?)').run(p);
      }
      if (allowedHostPatterns.length) console.log(`[DB] Seed sources_whitelist: ${allowedHostPatterns.length} pola dari JSON.`);
    }
  }
  const srcCount = hasSupabase()
    ? (await _pg`SELECT COUNT(*)::int AS n FROM sumber_crawl`)[0].n
    : sq().prepare('SELECT COUNT(*) AS n FROM sumber_crawl').get().n;
  if (srcCount === 0) {
    const srcPath = path.join(__dirname, '../../data/sources.json');
    if (fs.existsSync(srcPath)) {
      const { sources = [] } = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
      for (const s of sources) {
        const e = typeof s === 'string' ? { url: s } : s;
        if (!e.url) continue;
        const c = e.crawl ? 1 : 0;
        if (hasSupabase()) await _pg`INSERT INTO sumber_crawl (url, wilayah, crawl) VALUES (${e.url}, ${e.wilayah || null}, ${c}) ON CONFLICT (url) DO NOTHING`;
        else sq().prepare('INSERT OR IGNORE INTO sumber_crawl (url, wilayah, crawl) VALUES (?, ?, ?)').run(e.url, e.wilayah || null, c);
      }
      if (sources.length) console.log(`[DB] Seed sumber_crawl: ${sources.length} sumber dari JSON.`);
    }
  }
}

/** Akses langsung SQLite (hanya backend SQLite — untuk script admin raw-SQL). */
export function getDb() {
  return sqliteDb();
}

// Helper SQLite: jalankan callback sinkron dengan db.
const sq = () => sqliteDb();

// ---------- Grup ----------

export async function getGrup(idGrup) {
  await initDb();
  if (hasSupabase()) {
    const r = await _pg`SELECT * FROM grup WHERE id_grup = ${idGrup}`;
    return r[0] || null;
  }
  return sq().prepare("SELECT * FROM grup WHERE id_grup = ?").get(idGrup) || null;
}

export async function listActiveGrups() {
  await initDb();
  if (hasSupabase()) return [...(await _pg`SELECT * FROM grup WHERE status_start = 1`)];
  return sq().prepare("SELECT * FROM grup WHERE status_start = 1").all();
}

export async function upsertGrup({ idGrup, daerah, wilayahTag, provinsiTag }) {
  await initDb();
  const ts = new Date().toISOString();
  if (hasSupabase()) {
    await _pg`
      INSERT INTO grup (id_grup, daerah, wilayah_tag, provinsi_tag, status_start, tgl_start)
      VALUES (${idGrup}, ${daerah}, ${wilayahTag}, ${provinsiTag || null}, 1, ${ts})
      ON CONFLICT (id_grup) DO UPDATE SET
        daerah = EXCLUDED.daerah, wilayah_tag = EXCLUDED.wilayah_tag,
        provinsi_tag = EXCLUDED.provinsi_tag, status_start = 1, tgl_start = EXCLUDED.tgl_start`;
    return getGrup(idGrup);
  }
  sq()
    .prepare(
      `INSERT INTO grup (id_grup, daerah, wilayah_tag, provinsi_tag, status_start, tgl_start)
       VALUES (@idGrup, @daerah, @wilayahTag, @provinsiTag, 1, @ts)
       ON CONFLICT(id_grup) DO UPDATE SET
         daerah = excluded.daerah, wilayah_tag = excluded.wilayah_tag,
         provinsi_tag = excluded.provinsi_tag, status_start = 1, tgl_start = excluded.tgl_start`,
    )
    .run({ idGrup, daerah, wilayahTag, provinsiTag: provinsiTag || null, ts });
  return getGrup(idGrup);
}

// ---------- info_bansos ----------

export async function insertInfoBansos(info) {
  await initDb();
  if (hasSupabase()) {
    const [row] = await _pg`
      INSERT INTO info_bansos (program, ringkasan, syarat, tanggal_penting, batas_daftar, cara_daftar, wilayah_tag, sumber_url, tanggal_ambil, image_id, image_path)
      VALUES (${info.program}, ${info.ringkasan}, ${_pg.json(info.syarat || [])}, ${info.tanggal_penting || null},
              ${info.batas_daftar || null}, ${info.cara_daftar || null}, ${info.wilayah_tag}, ${info.sumber_url}, ${info.tanggal_ambil},
              ${info.image_id || null}, ${info.image_path || null})
      RETURNING id`;
    return row.id;
  }
  return sq()
    .prepare(
      `INSERT INTO info_bansos (program, ringkasan, syarat, tanggal_penting, batas_daftar, cara_daftar, wilayah_tag, sumber_url, tanggal_ambil, image_id, image_path)
       VALUES (@program, @ringkasan, @syarat, @tanggal_penting, @batas_daftar, @cara_daftar, @wilayah_tag, @sumber_url, @tanggal_ambil, @image_id, @image_path)`,
    )
    .run({
      program: info.program,
      ringkasan: info.ringkasan,
      syarat: JSON.stringify(info.syarat || []),
      tanggal_penting: info.tanggal_penting || null,
      batas_daftar: info.batas_daftar || null,
      cara_daftar: info.cara_daftar || null,
      wilayah_tag: info.wilayah_tag,
      sumber_url: info.sumber_url,
      tanggal_ambil: info.tanggal_ambil,
      image_id: info.image_id || null,
      image_path: info.image_path || null,
    }).lastInsertRowid;
}

export async function updateInfoBansosImage(id, { imageId, imagePath }) {
  await initDb();
  if (hasSupabase()) {
    await _pg`
      UPDATE info_bansos
      SET image_id = ${imageId || null}, image_path = ${imagePath || null}
      WHERE id = ${id}`;
    return;
  }
  sq()
    .prepare('UPDATE info_bansos SET image_id = ?, image_path = ? WHERE id = ?')
    .run(imageId || null, imagePath || null, id);
}

export async function countInfoBansos() {
  await initDb();
  if (hasSupabase()) return (await _pg`SELECT COUNT(*)::int AS n FROM info_bansos`)[0].n;
  return sq().prepare("SELECT COUNT(*) AS n FROM info_bansos").get().n;
}

export async function countInfoByWilayah(wilayahTag) {
  await initDb();
  if (hasSupabase()) return (await _pg`SELECT COUNT(*)::int AS n FROM info_bansos WHERE wilayah_tag = ${wilayahTag}`)[0].n;
  return sq().prepare("SELECT COUNT(*) AS n FROM info_bansos WHERE wilayah_tag = ?").get(wilayahTag).n;
}

/** Hapus info (+chunk) dari satu sumber_url. @returns {number} baris info_bansos terhapus */
export async function deleteInfoBySource(sumberUrl) {
  await initDb();
  if (hasSupabase()) {
    await _pg`DELETE FROM kb_chunks WHERE sumber_url = ${sumberUrl}`;
    const r = await _pg`DELETE FROM info_bansos WHERE sumber_url = ${sumberUrl}`;
    return r.count;
  }
  sq().prepare("DELETE FROM kb_chunks WHERE sumber_url = ?").run(sumberUrl);
  return sq().prepare("DELETE FROM info_bansos WHERE sumber_url = ?").run(sumberUrl).changes;
}

export async function resetKnowledge() {
  await initDb();
  if (hasSupabase()) {
    await _pg`DELETE FROM kb_chunks`;
    await _pg`DELETE FROM info_bansos`;
    return;
  }
  sq().exec("DELETE FROM kb_chunks; DELETE FROM info_bansos;");
}

// ---------- broadcast_log ----------

export async function wasBroadcast(fingerprint) {
  await initDb();
  if (hasSupabase()) return (await _pg`SELECT 1 FROM broadcast_log WHERE fingerprint = ${fingerprint}`).length > 0;
  return Boolean(sq().prepare("SELECT 1 FROM broadcast_log WHERE fingerprint = ?").get(fingerprint));
}

export async function markBroadcast({ fingerprint, program, wilayahTag, grupCount }) {
  await initDb();
  const ts = new Date().toISOString();
  if (hasSupabase()) {
    await _pg`
      INSERT INTO broadcast_log (fingerprint, program, wilayah_tag, grup_count, ts)
      VALUES (${fingerprint}, ${program || null}, ${wilayahTag || null}, ${grupCount ?? 0}, ${ts})
      ON CONFLICT (fingerprint) DO NOTHING`;
    return;
  }
  sq()
    .prepare(`INSERT OR IGNORE INTO broadcast_log (fingerprint, program, wilayah_tag, grup_count, ts) VALUES (?, ?, ?, ?, ?)`)
    .run(fingerprint, program || null, wilayahTag || null, grupCount ?? 0, ts);
}

// ---------- laporan ----------

function encodeSourceUrls(sourceUrls) {
  const urls = [...new Set((sourceUrls || []).map((u) => String(u || '').trim()).filter(Boolean))];
  return urls.length ? JSON.stringify(urls) : null;
}

export function parseLaporanSourceUrls(rowOrValue) {
  const raw = typeof rowOrValue === 'object' && rowOrValue ? rowOrValue.sumber_urls : rowOrValue;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

export function laporanHasSources(row) {
  return parseLaporanSourceUrls(row).length > 0;
}

export async function insertLaporan({ isiRingkas, modusKey, wilayahTag, status, dasarVerifikasi, sourceUrls = [], teksPeringatan }) {
  await initDb();
  const now = new Date().toISOString();
  const sumberUrls = encodeSourceUrls(sourceUrls);
  const vec = await embed(isiRingkas).catch(() => null);
  if (hasSupabase()) {
    const [row] = await _pg`
      INSERT INTO laporan (isi_ringkas, modus_key, wilayah_tag, status, dasar_verifikasi, sumber_urls, teks_peringatan, timestamp, updated_ts, embedding)
      VALUES (${isiRingkas}, ${modusKey || null}, ${wilayahTag}, ${status}, ${dasarVerifikasi || null}, ${sumberUrls}, ${teksPeringatan || null}, ${now}, ${now}, ${vec ? _pg.json(vec) : null})
      RETURNING id`;
    return row.id;
  }
  return sq()
    .prepare(
      `INSERT INTO laporan (isi_ringkas, modus_key, wilayah_tag, status, dasar_verifikasi, sumber_urls, teks_peringatan, timestamp, updated_ts, embedding)
       VALUES (@isi, @modus, @wilayah, @status, @dasar, @sumberUrls, @teks, @ts, @ts, @embedding)`,
    )
    .run({ isi: isiRingkas, modus: modusKey || null, wilayah: wilayahTag, status, dasar: dasarVerifikasi || null, sumberUrls, teks: teksPeringatan || null, ts: now, embedding: vec ? JSON.stringify(vec) : null }).lastInsertRowid;
}

export async function findClusterLaporan({ modusKey, wilayahTag, status }) {
  await initDb();
  if (!modusKey) return null;
  if (hasSupabase()) {
    const r = await _pg`
      SELECT * FROM laporan
      WHERE modus_key = ${modusKey} AND wilayah_tag = ${wilayahTag} AND status = ${status} AND status_approval = 'menunggu'
      ORDER BY id DESC LIMIT 1`;
    return r[0] || null;
  }
  return sq().prepare(`SELECT * FROM laporan WHERE modus_key = ? AND wilayah_tag = ? AND status = ? AND status_approval = 'menunggu' ORDER BY id DESC LIMIT 1`).get(modusKey, wilayahTag, status) || null;
}

const STOPWORDS = new Set([
  'ada',
  'atau',
  'dari',
  'dan',
  'di',
  'dengan',
  'ini',
  'itu',
  'jadi',
  'kalau',
  'karena',
  'ke',
  'laporan',
  'modus',
  'penipuan',
  'peringatan',
  'yang',
]);

function textTokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

function textSimilarity(a, b) {
  const aa = textTokens(a);
  const bb = textTokens(b);
  if (!aa.size || !bb.size) return 0;
  let inter = 0;
  for (const t of aa) if (bb.has(t)) inter++;
  const union = aa.size + bb.size - inter;
  const jaccard = union ? inter / union : 0;
  const containment = inter / Math.min(aa.size, bb.size);
  return Math.max(jaccard, containment * 0.82);
}

const COSINE_THRESHOLD = 0.75;

export async function findSimilarClusterLaporan({ modusKey, wilayahTag, status, isiRingkas, threshold = 0.58 }) {
  await initDb();
  const exact = modusKey && modusKey !== 'lainnya' ? await findClusterLaporan({ modusKey, wilayahTag, status }) : null;
  if (exact) return { ...exact, cluster_score: 1, cluster_reason: 'modus_key' };
  if (!isiRingkas || status === 'bukan_penipuan') return null;

  const rows = hasSupabase()
    ? [
        ...(await _pg`
          SELECT * FROM laporan
          WHERE wilayah_tag = ${wilayahTag}
            AND status = ${status}
            AND status_approval = 'menunggu'
          ORDER BY updated_ts DESC NULLS LAST, id DESC
          LIMIT 75`),
      ]
    : sq()
        .prepare(
          `SELECT * FROM laporan
           WHERE wilayah_tag = ? AND status = ? AND status_approval = 'menunggu'
           ORDER BY updated_ts DESC, id DESC LIMIT 75`,
        )
        .all(wilayahTag, status);

  const queryVec = await embed(isiRingkas).catch(() => null);

  let best = null;
  for (const row of rows) {
    let score;
    let reason;
    const rowVec = row.embedding
      ? (typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding)
      : null;

    if (queryVec && rowVec) {
      score = cosine(queryVec, rowVec);
      reason = 'cosine';
      if (score < COSINE_THRESHOLD) continue;
    } else {
      score = textSimilarity(isiRingkas, row.isi_ringkas);
      reason = 'similar_text';
      if (score < threshold) continue;
    }

    if (!best || score > best.cluster_score) {
      best = { ...row, cluster_score: score, cluster_reason: reason };
    }
  }
  return best;
}

export async function bumpLaporanSerupa(id, evidence = {}) {
  await initDb();
  const now = new Date().toISOString();
  const current = await getLaporan(id);
  const mergedSourceUrls = encodeSourceUrls([...parseLaporanSourceUrls(current), ...(evidence.sourceUrls || [])]);
  const dasarVerifikasi = evidence.dasarVerifikasi || current?.dasar_verifikasi || null;
  const teksPeringatan = current?.teks_peringatan || evidence.teksPeringatan || null;
  const clusterReason = evidence.clusterReason || current?.cluster_reason || null;
  if (hasSupabase()) {
    await _pg`
      UPDATE laporan
      SET jumlah_serupa = jumlah_serupa + 1,
          dasar_verifikasi = ${dasarVerifikasi},
          sumber_urls = ${mergedSourceUrls},
          teks_peringatan = ${teksPeringatan},
          cluster_reason = ${clusterReason},
          updated_ts = ${now}
      WHERE id = ${id}`;
  } else {
    sq()
      .prepare(
        `UPDATE laporan
         SET jumlah_serupa = jumlah_serupa + 1,
             dasar_verifikasi = ?,
             sumber_urls = ?,
             teks_peringatan = ?,
             cluster_reason = ?,
             updated_ts = ?
         WHERE id = ?`,
      )
      .run(dasarVerifikasi, mergedSourceUrls, teksPeringatan, clusterReason, now, id);
  }
  return getLaporan(id);
}

export async function getLaporan(id) {
  await initDb();
  if (hasSupabase()) return (await _pg`SELECT * FROM laporan WHERE id = ${id}`)[0] || null;
  return sq().prepare("SELECT * FROM laporan WHERE id = ?").get(id) || null;
}

/** Agregat modus penipuan yang lagi marak (digest "waspada nasional"). */
export async function trendingModus({ days = 30, limit = 5, wilayahTag = null } = {}) {
  await initDb();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  if (hasSupabase()) {
    return [
      ...(await _pg`
        SELECT modus_key, SUM(jumlah_serupa)::int AS total, COUNT(*)::int AS klaster
        FROM laporan
        WHERE timestamp >= ${cutoff} AND status IN ('jelas_penipuan','belum_pasti')
        ${wilayahTag ? _pg`AND wilayah_tag = ${wilayahTag}` : _pg``}
        GROUP BY modus_key ORDER BY total DESC, klaster DESC LIMIT ${limit}`),
    ];
  }
  const params = [cutoff];
  let sql = `SELECT modus_key, SUM(jumlah_serupa) AS total, COUNT(*) AS klaster
             FROM laporan WHERE timestamp >= ? AND status IN ('jelas_penipuan','belum_pasti')`;
  if (wilayahTag) {
    sql += " AND wilayah_tag = ?";
    params.push(wilayahTag);
  }
  sql += " GROUP BY modus_key ORDER BY total DESC, klaster DESC LIMIT ?";
  params.push(limit);
  return sq()
    .prepare(sql)
    .all(...params);
}

export async function listAntrianApproval() {
  await initDb();
  if (hasSupabase()) return [...(await _pg`SELECT * FROM laporan WHERE status = 'jelas_penipuan' AND status_approval = 'menunggu' ORDER BY jumlah_serupa DESC, id DESC`)];
  return sq().prepare(`SELECT * FROM laporan WHERE status = 'jelas_penipuan' AND status_approval = 'menunggu' ORDER BY jumlah_serupa DESC, id DESC`).all();
}

export async function listLaporanSiapBroadcast() {
  await initDb();
  if (hasSupabase()) {
    return [
      ...(await _pg`
        SELECT * FROM laporan
        WHERE status = 'jelas_penipuan'
          AND status_approval = 'menunggu'
          AND sumber_urls IS NOT NULL
          AND sumber_urls <> ''
          AND sumber_urls <> '[]'
        ORDER BY jumlah_serupa DESC, id DESC`),
    ];
  }
  return sq()
    .prepare(
      `SELECT * FROM laporan
       WHERE status = 'jelas_penipuan'
         AND status_approval = 'menunggu'
         AND sumber_urls IS NOT NULL
         AND sumber_urls <> ''
         AND sumber_urls <> '[]'
       ORDER BY jumlah_serupa DESC, id DESC`,
    )
    .all();
}

export async function listLaporanPerluVerifikasi() {
  await initDb();
  if (hasSupabase()) {
    return [
      ...(await _pg`
        SELECT * FROM laporan
        WHERE status IN ('jelas_penipuan','belum_pasti')
          AND status_approval = 'menunggu'
          AND (sumber_urls IS NULL OR sumber_urls = '' OR sumber_urls = '[]')
        ORDER BY jumlah_serupa DESC, id DESC`),
    ];
  }
  return sq()
    .prepare(
      `SELECT * FROM laporan
       WHERE status IN ('jelas_penipuan','belum_pasti')
         AND status_approval = 'menunggu'
         AND (sumber_urls IS NULL OR sumber_urls = '' OR sumber_urls = '[]')
       ORDER BY jumlah_serupa DESC, id DESC`,
    )
    .all();
}

export async function listPrioritasBelumPasti(minSerupa = 3) {
  await initDb();
  if (hasSupabase()) return [...(await _pg`SELECT * FROM laporan WHERE status = 'belum_pasti' AND status_approval = 'menunggu' AND jumlah_serupa >= ${minSerupa} ORDER BY jumlah_serupa DESC, id DESC`)];
  return sq().prepare(`SELECT * FROM laporan WHERE status = 'belum_pasti' AND status_approval = 'menunggu' AND jumlah_serupa >= ? ORDER BY jumlah_serupa DESC, id DESC`).all(minSerupa);
}

export async function setApprovalLaporan(id, statusApproval, teksPeringatan) {
  await initDb();
  const now = new Date().toISOString();
  if (hasSupabase()) {
    if (teksPeringatan != null) {
      await _pg`UPDATE laporan SET status_approval = ${statusApproval}, teks_peringatan = ${teksPeringatan}, updated_ts = ${now} WHERE id = ${id}`;
    } else {
      await _pg`UPDATE laporan SET status_approval = ${statusApproval}, updated_ts = ${now} WHERE id = ${id}`;
    }
    return getLaporan(id);
  }
  if (teksPeringatan != null) {
    sq().prepare(`UPDATE laporan SET status_approval = ?, teks_peringatan = ?, updated_ts = ? WHERE id = ?`).run(statusApproval, teksPeringatan, now, id);
  } else {
    sq().prepare(`UPDATE laporan SET status_approval = ?, updated_ts = ? WHERE id = ?`).run(statusApproval, now, id);
  }
  return getLaporan(id);
}

// ---------- laporan layanan publik ----------

export async function insertLaporanLayanan({ kategori, deskripsi, lokasiDetail, wilayahTag, fotoPath, fotoOcr, portalTarget = "laporgub", messageId = null, sessionId = null, notes = null }) {
  await initDb();
  const now = new Date().toISOString();
  if (hasSupabase()) {
    const [row] = await _pg`
      INSERT INTO laporan_layanan (kategori, deskripsi, lokasi_detail, wilayah_tag, foto_path, foto_ocr, portal_target, status, message_id, session_id, timestamp, notes)
      VALUES (${kategori}, ${deskripsi}, ${lokasiDetail}, ${wilayahTag || null}, ${fotoPath || null}, ${fotoOcr || null}, ${portalTarget}, 'draft', ${messageId || null}, ${sessionId || null}, ${now}, ${notes || null})
      RETURNING id`;
    return row.id;
  }
  return sq()
    .prepare(
      `INSERT INTO laporan_layanan (kategori, deskripsi, lokasi_detail, wilayah_tag, foto_path, foto_ocr, portal_target, status, message_id, session_id, timestamp, notes)
       VALUES (@kategori, @deskripsi, @lokasiDetail, @wilayahTag, @fotoPath, @fotoOcr, @portalTarget, 'draft', @messageId, @sessionId, @ts, @notes)`,
    )
    .run({
      kategori,
      deskripsi,
      lokasiDetail,
      wilayahTag: wilayahTag || null,
      fotoPath: fotoPath || null,
      fotoOcr: fotoOcr || null,
      portalTarget,
      messageId: messageId || null,
      sessionId: sessionId || null,
      ts: now,
      notes: notes || null,
    }).lastInsertRowid;
}

export async function updateLaporanLayananStatus(id, status, fields = {}) {
  await initDb();
  const now = new Date().toISOString();
  const updates = ["status = ?"];
  const params = [status];
  if (fields.nomor_ticket !== undefined) {
    updates.push("nomor_ticket = ?");
    params.push(fields.nomor_ticket);
  }
  if (fields.submitted_at !== undefined) {
    updates.push("submitted_at = ?");
    params.push(fields.submitted_at);
  }
  if (fields.last_status_check !== undefined) {
    updates.push("last_status_check = ?");
    params.push(fields.last_status_check);
  }
  if (fields.last_status_notified_at !== undefined) {
    updates.push("last_status_notified_at = ?");
    params.push(fields.last_status_notified_at);
  }
  if (fields.notes !== undefined) {
    updates.push("notes = ?");
    params.push(fields.notes);
  }
  updates.push("timestamp = ?");
  params.push(now);
  params.push(id);

  if (hasSupabase()) {
    const setters = ["status = $1"];
    const values = [status];
    if (fields.nomor_ticket !== undefined) {
      setters.push(`nomor_ticket = $${values.length + 1}`);
      values.push(fields.nomor_ticket);
    }
    if (fields.submitted_at !== undefined) {
      setters.push(`submitted_at = $${values.length + 1}`);
      values.push(fields.submitted_at);
    }
    if (fields.last_status_check !== undefined) {
      setters.push(`last_status_check = $${values.length + 1}`);
      values.push(fields.last_status_check);
    }
    if (fields.last_status_notified_at !== undefined) {
      setters.push(`last_status_notified_at = $${values.length + 1}`);
      values.push(fields.last_status_notified_at);
    }
    if (fields.notes !== undefined) {
      setters.push(`notes = $${values.length + 1}`);
      values.push(fields.notes);
    }
    setters.push(`timestamp = $${values.length + 1}`);
    values.push(now);
    values.push(id);
    await _pg.unsafe(`UPDATE laporan_layanan SET ${setters.join(", ")} WHERE id = $${values.length}`, values);
    return getLaporanLayanan(id);
  }

  sq()
    .prepare(`UPDATE laporan_layanan SET ${updates.join(", ")} WHERE id = ?`)
    .run(...params);
  return getLaporanLayanan(id);
}

export async function getLaporanLayanan(id) {
  await initDb();
  if (hasSupabase()) return (await _pg`SELECT * FROM laporan_layanan WHERE id = ${id}`)[0] || null;
  return sq().prepare("SELECT * FROM laporan_layanan WHERE id = ?").get(id) || null;
}

export async function listPendingLaporanLayanan() {
  await initDb();
  if (hasSupabase()) return [...(await _pg`SELECT * FROM laporan_layanan WHERE status IN ('draft','confirmed','failed') ORDER BY timestamp ASC`)];
  return sq().prepare(`SELECT * FROM laporan_layanan WHERE status IN ('draft','confirmed','failed') ORDER BY timestamp ASC`).all();
}

export async function listSubmittedLaporanLayanan({ portalTarget = null } = {}) {
  await initDb();
  if (hasSupabase()) {
    if (portalTarget) {
      return [...(await _pg`SELECT * FROM laporan_layanan WHERE status = 'submitted' AND portal_target = ${portalTarget} ORDER BY timestamp ASC`)];
    }
    return [...(await _pg`SELECT * FROM laporan_layanan WHERE status = 'submitted' ORDER BY timestamp ASC`)];
  }
  if (portalTarget) {
    return sq().prepare(`SELECT * FROM laporan_layanan WHERE status = 'submitted' AND portal_target = ? ORDER BY timestamp ASC`).all(portalTarget);
  }
  return sq().prepare(`SELECT * FROM laporan_layanan WHERE status = 'submitted' ORDER BY timestamp ASC`).all();
}

export async function listAduanKontenReportsForSession(sessionId, { limit = 30 } = {}) {
  await initDb();
  const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  if (hasSupabase()) {
    return [
      ...(await _pg`
        SELECT *
        FROM laporan_layanan
        WHERE portal_target = 'aduankonten'
          AND session_id = ${sessionId}
          AND nomor_ticket IS NOT NULL
          AND nomor_ticket <> ''
        ORDER BY COALESCE(submitted_at, timestamp) DESC, id DESC
        LIMIT ${normalizedLimit}`),
    ];
  }
  return sq()
    .prepare(
      `SELECT *
       FROM laporan_layanan
       WHERE portal_target = 'aduankonten'
         AND session_id = ?
         AND nomor_ticket IS NOT NULL
         AND nomor_ticket <> ''
       ORDER BY COALESCE(submitted_at, timestamp) DESC, id DESC
       LIMIT ?`,
    )
    .all(sessionId, normalizedLimit);
}

export async function insertLaporanLayananSubmitLog({ laporanId, portal, attempt, status, errorMsg }) {
  await initDb();
  const now = new Date().toISOString();
  if (hasSupabase()) {
    await _pg`
      INSERT INTO laporan_layanan_submit_log (laporan_id, portal, attempt, status, error_msg, timestamp)
      VALUES (${laporanId}, ${portal}, ${attempt}, ${status}, ${errorMsg || null}, ${now})`;
    return;
  }
  sq()
    .prepare(
      `INSERT INTO laporan_layanan_submit_log (laporan_id, portal, attempt, status, error_msg, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(laporanId, portal, attempt, status, errorMsg || null, now);
}

export async function listLaporanApprovedPendingBroadcast() {
  await initDb();
  if (hasSupabase()) {
    return [
      ...(await _pg`
        SELECT l.* FROM laporan l
        LEFT JOIN peringatan_terkirim pt ON pt.laporan_id = l.id
        WHERE l.status_approval = 'disetujui'
          AND pt.laporan_id IS NULL
        ORDER BY l.id DESC`),
    ];
  }
  return sq()
    .prepare(
      `SELECT l.* FROM laporan l
       LEFT JOIN peringatan_terkirim pt ON pt.laporan_id = l.id
       WHERE l.status_approval = 'disetujui'
         AND pt.laporan_id IS NULL
       ORDER BY l.id DESC`,
    )
    .all();
}

// ---------- peringatan_terkirim ----------

export async function wasPeringatanSent(laporanId) {
  await initDb();
  if (hasSupabase()) return (await _pg`SELECT 1 FROM peringatan_terkirim WHERE laporan_id = ${laporanId}`).length > 0;
  return Boolean(sq().prepare("SELECT 1 FROM peringatan_terkirim WHERE laporan_id = ?").get(laporanId));
}

export async function markPeringatanTerkirim({ laporanId, wilayahTag, grupCount }) {
  await initDb();
  const ts = new Date().toISOString();
  if (hasSupabase()) {
    await _pg`INSERT INTO peringatan_terkirim (laporan_id, wilayah_tag, grup_count, timestamp) VALUES (${laporanId}, ${wilayahTag || null}, ${grupCount ?? 0}, ${ts})`;
    return;
  }
  sq()
    .prepare(`INSERT INTO peringatan_terkirim (laporan_id, wilayah_tag, grup_count, timestamp) VALUES (?, ?, ?, ?)`)
    .run(laporanId, wilayahTag || null, grupCount ?? 0, ts);
}

// ---------- log_interaksi ----------

export async function logInteraksi({ konteks, jenis, aksi = null, label, wilayahTag, ringkasPesan = null, ringkasResp = null }) {
  await initDb();
  const ts = new Date().toISOString();
  if (hasSupabase()) {
    await _pg`
      INSERT INTO log_interaksi (konteks, jenis, aksi, label, wilayah_tag, ringkas_pesan, ringkas_resp, timestamp)
      VALUES (${konteks || null}, ${jenis || null}, ${aksi || jenis || null}, ${label || null}, ${wilayahTag || null}, ${ringkasPesan || null}, ${ringkasResp || null}, ${ts})`;
    return;
  }
  sq()
    .prepare(
      `INSERT INTO log_interaksi (konteks, jenis, aksi, label, wilayah_tag, ringkas_pesan, ringkas_resp, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(konteks || null, jenis || null, aksi || jenis || null, label || null, wilayahTag || null, ringkasPesan || null, ringkasResp || null, ts);
}

// ---------- kb_chunks (vector store) ----------

export async function insertChunk(c) {
  await initDb();
  if (hasSupabase()) {
    await _pg`
      INSERT INTO kb_chunks (info_id, program, content, embedding, dim, sumber_url, wilayah_tag, tanggal_ambil, batas_daftar)
      VALUES (${c.info_id}, ${c.program}, ${c.content}, ${_pg.json(c.embedding)}, ${c.embedding.length}, ${c.sumber_url}, ${c.wilayah_tag}, ${c.tanggal_ambil}, ${c.batas_daftar || null})`;
    return;
  }
  sq()
    .prepare(
      `INSERT INTO kb_chunks (info_id, program, content, embedding, dim, sumber_url, wilayah_tag, tanggal_ambil, batas_daftar)
       VALUES (@info_id, @program, @content, @embedding, @dim, @sumber_url, @wilayah_tag, @tanggal_ambil, @batas_daftar)`,
    )
    .run({
      info_id: c.info_id,
      program: c.program,
      content: c.content,
      embedding: JSON.stringify(c.embedding),
      dim: c.embedding.length,
      sumber_url: c.sumber_url,
      wilayah_tag: c.wilayah_tag,
      tanggal_ambil: c.tanggal_ambil,
      batas_daftar: c.batas_daftar || null,
    });
}

export async function allChunks() {
  await initDb();
  const rows = hasSupabase() ? [...(await _pg`SELECT * FROM kb_chunks`)] : sq().prepare("SELECT * FROM kb_chunks").all();
  // embedding: Postgres JSONB → sudah array; SQLite TEXT → perlu parse.
  return rows.map((r) => ({ ...r, embedding: typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding }));
}

export async function countChunks() {
  await initDb();
  if (hasSupabase()) return (await _pg`SELECT COUNT(*)::int AS n FROM kb_chunks`)[0].n;
  return sq().prepare("SELECT COUNT(*) AS n FROM kb_chunks").get().n;
}

// ---------- sources_whitelist ----------

export async function listWhitelistPatterns() {
  await initDb();
  if (hasSupabase()) return [...(await _pg`SELECT id, pattern FROM sources_whitelist WHERE aktif = 1 ORDER BY id`)];
  return sq().prepare('SELECT id, pattern FROM sources_whitelist WHERE aktif = 1 ORDER BY id').all();
}

export async function upsertWhitelistPattern(pattern) {
  await initDb();
  if (hasSupabase()) {
    await _pg`INSERT INTO sources_whitelist (pattern) VALUES (${pattern}) ON CONFLICT (pattern) DO UPDATE SET aktif = 1`;
  } else {
    sq().prepare('INSERT OR REPLACE INTO sources_whitelist (pattern, aktif) VALUES (?, 1)').run(pattern);
  }
}

export async function deleteWhitelistPattern(id) {
  await initDb();
  if (hasSupabase()) await _pg`DELETE FROM sources_whitelist WHERE id = ${id}`;
  else sq().prepare('DELETE FROM sources_whitelist WHERE id = ?').run(id);
}

// ---------- sumber_crawl ----------

export async function listSumberCrawl() {
  await initDb();
  if (hasSupabase()) return [...(await _pg`SELECT * FROM sumber_crawl WHERE aktif = 1 ORDER BY id`)];
  return sq().prepare('SELECT * FROM sumber_crawl WHERE aktif = 1 ORDER BY id').all();
}

export async function upsertSumberCrawl({ url, wilayah, crawl = false }) {
  await initDb();
  const c = crawl ? 1 : 0;
  if (hasSupabase()) {
    await _pg`
      INSERT INTO sumber_crawl (url, wilayah, crawl)
      VALUES (${url}, ${wilayah || null}, ${c})
      ON CONFLICT (url) DO UPDATE SET wilayah = EXCLUDED.wilayah, crawl = EXCLUDED.crawl, aktif = 1`;
  } else {
    sq().prepare('INSERT OR REPLACE INTO sumber_crawl (url, wilayah, crawl, aktif) VALUES (?, ?, ?, 1)').run(url, wilayah || null, c);
  }
}

export async function deleteSumberCrawl(id) {
  await initDb();
  if (hasSupabase()) await _pg`DELETE FROM sumber_crawl WHERE id = ${id}`;
  else sq().prepare('DELETE FROM sumber_crawl WHERE id = ?').run(id);
}
