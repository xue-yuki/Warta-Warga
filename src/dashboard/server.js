// Dashboard Approval Pengurus (Fitur Lapor & Peringatan Dini, §6 PRD).
// Lapis 2 (human-in-the-loop): pengurus meninjau antrian 'jelas_penipuan' lalu approve/tolak.
// Hanya yang di-approve yang memicu broadcastPeringatan. AI tidak pernah menyebar sendiri.
//
// CATATAN: dashboard idealnya berjalan DI DALAM proses bot (src/index.js) agar approve langsung
// memakai koneksi WhatsApp yang aktif untuk menyebar peringatan. Tanpa koneksi (mis. dijalankan
// standalone), approve tetap tercatat tapi penyebaran ditunda (broadcastPeringatan → no-sender).

import express from 'express';
import { listAntrianApproval, listPrioritasBelumPasti, getLaporan, setApprovalLaporan, trendingModus } from '../db/index.js';
import { broadcastPeringatan, formatPeringatan, hasBroadcaster, URGENT_THRESHOLD, broadcastTrenNasional } from '../agent1/broadcast.js';
import { humanWilayah } from '../util/wilayah.js';
import { humanModus } from '../agent2/lapor.js';

const TREN_DAYS = 30;
const trenItems = async () => (await trendingModus({ days: TREN_DAYS, limit: 5 })).map((r) => ({ label: humanModus(r.modus_key), total: r.total }));

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function kartu(l, { prioritas = false } = {}) {
  const preview = formatPeringatan(l);
  const urgent = l.jumlah_serupa >= URGENT_THRESHOLD;
  return `
  <div class="card${prioritas ? ' prio' : ''}${urgent ? ' urgent' : ''}">
    <div class="head">
      ${urgent ? '<span class="badge b-urgent">🚨 URGENT</span>' : ''}
      <span class="badge ${prioritas ? 'b-prio' : 'b-tipu'}">${prioritas ? 'PRIORITAS TINJAU' : 'JELAS PENIPUAN'}</span>
      <span class="wil">📍 ${esc(humanWilayah(l.wilayah_tag))}</span>
      <span class="cnt">📈 ${l.jumlah_serupa} laporan serupa</span>
      <span class="id">#${l.id}</span>
    </div>
    <div class="modus"><b>Modus:</b> ${esc(l.isi_ringkas)}</div>
    ${l.dasar_verifikasi ? `<div class="dasar"><b>Dasar tinjauan AI:</b> ${esc(l.dasar_verifikasi)}</div>` : ''}
    <form method="POST" action="/laporan/${l.id}/approve">
      <label>Teks peringatan (boleh diedit sebelum sebar):</label>
      <textarea name="teks" rows="4">${esc(l.teks_peringatan || '')}</textarea>
      <details><summary>Pratinjau kartu broadcast</summary><pre>${esc(preview)}</pre></details>
      <div class="actions">
        <button class="ok" type="submit">✅ Approve &amp; sebar peringatan</button>
        <button class="no" type="submit" formaction="/laporan/${l.id}/reject">🚫 Tolak</button>
      </div>
    </form>
  </div>`;
}

async function halaman({ flash } = {}) {
  const antrian = await listAntrianApproval();
  const prioritas = await listPrioritasBelumPasti(3);
  const items = await trenItems();
  const online = hasBroadcaster();
  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Warta Warga — Antrian Peringatan</title>
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:780px;margin:0 auto;padding:16px;background:#f6f7f9;color:#1f2937}
    h1{font-size:20px;margin:.2em 0}
    .sub{color:#6b7280;font-size:13px;margin-bottom:14px}
    .status{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px}
    .on{background:#dcfce7;color:#166534}.off{background:#fee2e2;color:#991b1b}
    .flash{background:#eff6ff;border:1px solid #bfdbfe;padding:10px 12px;border-radius:8px;margin:10px 0;font-size:14px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .card.prio{border-left:4px solid #f59e0b}
    .card.urgent{border-left:4px solid #ef4444;box-shadow:0 0 0 1px #fecaca,0 1px 3px rgba(239,68,68,.2)}
    .b-urgent{background:#ef4444;color:#fff}
    .head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;margin-bottom:8px}
    .badge{font-weight:700;padding:2px 8px;border-radius:6px}
    .b-tipu{background:#fee2e2;color:#991b1b}.b-prio{background:#fef3c7;color:#92400e}
    .b-tren{background:#dbeafe;color:#1e40af}.card.tren{border-left:4px solid #3b82f6}
    .trenlist{margin:8px 0;padding-left:22px}.trenlist li{margin:3px 0}
    .wil,.cnt{color:#374151}.id{margin-left:auto;color:#9ca3af}
    .modus{margin:6px 0}.dasar{font-size:13px;color:#4b5563;margin:6px 0}
    label{display:block;font-size:12px;color:#6b7280;margin-top:8px}
    textarea{width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:8px;font:inherit}
    pre{white-space:pre-wrap;background:#f9fafb;border:1px solid #eee;border-radius:8px;padding:8px;font-size:12px}
    .actions{display:flex;gap:8px;margin-top:10px}
    button{border:0;border-radius:8px;padding:9px 12px;font-weight:600;cursor:pointer}
    .ok{background:#16a34a;color:#fff}.no{background:#ef4444;color:#fff}
    .empty{color:#6b7280;text-align:center;padding:24px}
  </style></head><body>
  <h1>🛡️ Antrian Peringatan Dini — Pengurus</h1>
  <div class="sub">Tinjau laporan penipuan, lalu <b>Approve</b> untuk menyebar peringatan ke grup sewilayah.
    Status bot: <span class="status ${online ? 'on' : 'off'}">${online ? 'terhubung WhatsApp' : 'tidak terhubung (penyebaran ditunda)'}</span></div>
  ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
  ${
    items.length
      ? `<div class="card tren">
      <div class="head"><span class="badge b-tren">📊 LAGI MARAK</span><span class="wil">Nasional · ${TREN_DAYS} hari terakhir</span></div>
      <ol class="trenlist">${items.map((it) => `<li><b>${esc(it.label)}</b> — ${it.total} laporan</li>`).join('')}</ol>
      <form method="POST" action="/tren/sebar-nasional" onsubmit="return confirm('Sebar digest ini ke SEMUA grup terdaftar?')">
        <div class="actions"><button class="ok" type="submit">📢 Sebar digest ke semua grup</button></div>
      </form>
    </div>`
      : ''
  }
  <h2 style="font-size:15px">Menunggu approval (${antrian.length})</h2>
  ${antrian.length ? antrian.map((l) => kartu(l)).join('') : '<div class="empty">Tidak ada antrian. 🎉</div>'}
  ${prioritas.length ? `<h2 style="font-size:15px">Prioritas tinjau — laporan menumpuk (${prioritas.length})</h2>${prioritas.map((l) => kartu(l, { prioritas: true })).join('')}` : ''}
  </body></html>`;
}

export function createDashboardApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/', async (req, res) => res.send(await halaman({ flash: req.query.flash })));

  app.post('/laporan/:id/approve', async (req, res) => {
    const id = Number(req.params.id);
    const teks = (req.body?.teks || '').trim() || null;
    await setApprovalLaporan(id, 'disetujui', teks);
    const r = await broadcastPeringatan(await getLaporan(id)).catch((e) => ({ sent: 0, reason: e.message }));
    const flash =
      r.sent > 0
        ? `✅ Laporan #${id} disetujui & peringatan disebar ke ${r.sent} grup.`
        : `✅ Laporan #${id} disetujui. Penyebaran tertunda (${r.reason || 'tidak ada grup/koneksi'}).`;
    res.redirect('/?flash=' + encodeURIComponent(flash));
  });

  app.post('/tren/sebar-nasional', async (req, res) => {
    const items = await trenItems();
    const r = await broadcastTrenNasional(items, { scope: 'Nasional', days: TREN_DAYS }).catch((e) => ({ sent: 0, reason: e.message }));
    const flash =
      r.sent > 0
        ? `📢 Digest "lagi marak" disebar ke ${r.sent} grup.`
        : `Digest belum tersebar (${r.reason || 'tidak ada data/grup/koneksi'}).`;
    res.redirect('/?flash=' + encodeURIComponent(flash));
  });

  app.post('/laporan/:id/reject', async (req, res) => {
    const id = Number(req.params.id);
    await setApprovalLaporan(id, 'ditolak');
    res.redirect('/?flash=' + encodeURIComponent(`🚫 Laporan #${id} ditolak — tidak akan disebar.`));
  });

  return app;
}

/** Jalankan dashboard. Aman: bind ke localhost (dashboard pengurus, bukan publik). */
export function startDashboard(port = Number(process.env.DASHBOARD_PORT) || 3210) {
  const server = createDashboardApp().listen(port, '127.0.0.1', () => {
    console.log(`🛡️  Dashboard pengurus: http://127.0.0.1:${port}`);
  });
  return server;
}
