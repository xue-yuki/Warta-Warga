// Klien tipis untuk REST API kirimi.id — field-field di bawah cocok dengan OpenAPI resmi
// kirimi.id (send-message pakai 'phone', bukan 'receiver'; broadcast-message pakai 'phones'
// berupa string dipisah koma, bukan array 'numbers'). Auth: user_code + device_id + secret
// dikirim di body setiap request.

import axios from "axios";
import { config, hasKirimi } from "../config.js";

export { hasKirimi };

function client() {
  return axios.create({ baseURL: config.kirimi.baseUrl, timeout: 20000 });
}

function authFields() {
  return {
    user_code: config.kirimi.userCode,
    device_id: config.kirimi.deviceId,
    secret: config.kirimi.secretKey,
  };
}

/** Kirim satu pesan teks (+ media opsional lewat URL, bukan upload buffer). */
export async function kirimiSendMessage({ to, message, mediaUrl } = {}) {
  if (!hasKirimi()) throw new Error("kirimi.id belum dikonfigurasi (USER_CODE/KIRIMI_SECRET_KEY/KIRIMI_DEVICE_ID kosong).");
  if (!to) throw new Error("kirimiSendMessage: 'to' wajib diisi.");
  const payload = {
    ...authFields(),
    phone: to,
    message: message || "",
  };
  if (mediaUrl) payload.media_url = mediaUrl;
  const { data } = await client().post("/v1/send-message", payload);
  return data;
}

/** Cek status koneksi device kirimi.id (dipakai dashboard — kirimi tidak butuh QR di sisi kita). */
export async function kirimiDeviceStatus() {
  if (!hasKirimi()) throw new Error("kirimi.id belum dikonfigurasi (USER_CODE/KIRIMI_SECRET_KEY/KIRIMI_DEVICE_ID kosong).");
  const { data } = await client().post("/v1/device-status", authFields());
  return data;
}

/** Broadcast satu pesan ke banyak nomor sekaligus (dijeda otomatis oleh kirimi di sisi server). */
export async function kirimiBroadcastMessage({ numbers, message, delaySeconds } = {}) {
  if (!hasKirimi()) throw new Error("kirimi.id belum dikonfigurasi (USER_CODE/KIRIMI_SECRET_KEY/KIRIMI_DEVICE_ID kosong).");
  if (!Array.isArray(numbers) || !numbers.length) throw new Error("kirimiBroadcastMessage: 'numbers' wajib berupa array tidak kosong.");
  const payload = {
    ...authFields(),
    phones: numbers.join(","),
    message: message || "",
  };
  if (delaySeconds) payload.delay = delaySeconds;
  const { data } = await client().post("/v1/broadcast-message", payload);
  return data;
}
