// Status koneksi WA transport 'baileys' — dibaca oleh dashboard (src/dashboard/server.js) supaya
// admin bisa scan QR & lihat status koneksi dari browser, bukan dari terminal CLI.
// Tidak dipakai oleh transport 'kirimi' (status koneksinya diambil live dari API kirimi.id, lihat
// kirimiDeviceStatus() di kirimiClient.js — kirimi tidak butuh QR di sisi kita sama sekali).

let state = {
  status: "idle", // idle | connecting | qr_pending | connected | disconnected | logged_out | off
  qr: null, // data URL PNG (hasil qrcode.toDataURL), null kalau tidak sedang menunggu scan
  connectedAs: null, // nomor/JID setelah berhasil connect
  updatedAt: null,
};

export function setBaileysStatus(status, extra = {}) {
  state = { status, qr: null, connectedAs: state.connectedAs, ...extra, updatedAt: Date.now() };
}

export function getBaileysStatus() {
  return state;
}
