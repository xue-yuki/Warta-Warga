import { chatJson } from '../llm/openrouter.js';
import { normalizeWilayahTag } from '../util/wilayah.js';

const SYSTEM = `Kamu adalah Verifikator Sumber untuk asisten info bansos di Indonesia.
Tugasmu: mengubah teks pengumuman birokrasi menjadi objek JSON terstruktur dalam bahasa Indonesia yang sangat sederhana (mudah dipahami warga awam).
ATURAN KERAS:
- Hanya gunakan informasi yang ADA di teks. JANGAN menambah/menebak fakta.
- Jika sebuah field tidak ada di teks, isi null (atau [] untuk syarat).
- Bahasa ringkasan: santun, singkat, tanpa istilah birokrasi.

PENTING — FILTER RELEVANSI:
Yang dianggap PROGRAM BANSOS (relevan) HANYA: program bantuan/subsidi/jaminan untuk warga,
misalnya bantuan tunai (PKH, BLT), bantuan pangan/sembako (BPNT), bantuan pendidikan (PIP/KIP),
jaminan kesehatan (PBI-JKN/KIS), bantuan disabilitas/lansia, subsidi, atau bantuan bencana.
Yang BUKAN bansos (TIDAK relevan), tandai relevan_bansos=false:
- Lowongan kerja / rekrutmen / seleksi pegawai (CPNS, PPPK, honorer).
- Pengumuman lelang / tender / pengadaan barang.
- Halaman ALAT/aplikasi (mis. form pencarian/cek data penerima, halaman login).
- Berita umum, agenda/kunjungan pejabat, siaran pers, profil lembaga.
- Halaman error/404 atau navigasi kosong.
- Halaman DEFINISI/UMUM atau landing/daftar: hanya menjelaskan ISTILAH secara umum
  (mis. "apa itu bantuan sosial") TANPA satu program spesifik yang bernama & bisa didaftar.
PROGRAM HARUS SPESIFIK & PUNYA NAMA RESMI (mis. "PKH", "BPNT/Sembako", "PIP", "BLT Dana Desa",
"Rutilahu"). Kalau teks cuma bicara "bantuan sosial"/"bansos" sebagai istilah umum tanpa nama
program konkret → relevan_bansos=false dan jenis_konten="definisi_umum".

HALAMAN PROGRAM vs ARTIKEL BERITA (penting):
- RELEVAN hanya HALAMAN PROGRAM RESMI itu sendiri — yang menjelaskan program: apa itu, syarat, cara daftar.
- ARTIKEL BERITA / siaran pers / liputan kegiatan / agenda pejabat yang HANYA menyebut/membahas program
  (mis. "Pemkot serahkan bansos PKH ke 200 KK", "Digitalisasi penyaluran bansos", kunjungan/peresmian) →
  relevan_bansos=false, jenis_konten="berita_umum". JANGAN diperlakukan sebagai halaman program.
- Ciri BERITA: ada tanggal terbit/penulis, narasi peristiwa & kutipan pejabat, fokus pada kejadian —
  BUKAN deskripsi syarat & cara daftar. Kalau ragu antara halaman-program vs berita → pilih berita_umum.`;

function userPrompt(text, hintWilayah) {
  const hariIni = new Date().toISOString().slice(0, 10);
  return `Hari ini: ${hariIni}.
Strukturkan pengumuman berikut menjadi JSON dengan skema PERSIS ini:
{
  "relevan_bansos": boolean,               // true HANYA jika ini PROGRAM BANSOS untuk warga (lihat aturan filter)
  "jenis_konten": string,                  // "program_bansos" | "lowongan_kerja" | "lelang" | "alat_pencarian" | "berita_umum" | "definisi_umum" | "lainnya"
  "program": string,                       // nama program bansos
  "ringkasan_bahasa_sederhana": string,    // 1-3 kalimat, bahasa awam
  "syarat": string[],                      // daftar syarat; [] jika tidak ada
  "tanggal_penting": string|null,          // lihat ATURAN TANGGAL
  "batas_daftar": string|null,             // TENGGAT pendaftaran eksplisit (format YYYY-MM-DD jika jelas), lihat ATURAN TANGGAL
  "cara_daftar": string|null,              // langkah daftar jika disebut
  "wilayah_tag": string,                   // "nasional" | "provinsi:<x>" | "kabupaten:<x>"
  "valid": boolean                         // false jika teks tidak bisa distrukturkan sama sekali
}
ATURAN TANGGAL (tanggal_penting):
- Isi HANYA jadwal/tenggat yang RELEVAN bagi calon penerima: kapan pendaftaran dibuka/ditutup atau bantuan disalurkan.
- DILARANG mengisi dengan tanggal TERBIT/UPDATE artikel, tanggal berita, atau timestamp halaman.
- Jika jadwalnya berulang/umum, tulis sebagai teks ("Disalurkan per tahap tiap tahun", "Pendaftaran tiap awal triwulan"), JANGAN satu tanggal.
- Jika satu-satunya tanggal di teks sudah LEWAT dari hari ini (kemungkinan tanggal terbit), isi tanggal_penting null.
- Jika tidak ada jadwal yang jelas → null.
- batas_daftar: isi HANYA bila teks menyebut TENGGAT/BATAS AKHIR pendaftaran yang spesifik (mis. "pendaftaran ditutup 31 Agustus 2026"). Format YYYY-MM-DD bila tanggalnya jelas. Ini BUKAN tanggal terbit. Jika tidak ada tenggat eksplisit → null.
${hintWilayah ? `Petunjuk wilayah (pakai jika teks tidak menyebut wilayah lain): ${hintWilayah}\n` : ''}
TEKS:
"""
${text.slice(0, 6000)}
"""`;
}

/**
 * Strukturkan teks menjadi objek info bansos via LLM (model deep).
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
export async function structureContent(text, { hintWilayah, sumberUrl } = {}) {
  let parsed;
  try {
    parsed = await chatJson({
      tier: 'deep',
      temperature: 0.1,
      maxTokens: 2000, // lega untuk JSON sumber panjang (program, ringkasan, syarat[], dst) tanpa kepotong
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(text, hintWilayah) },
      ],
    });
  } catch (err) {
    return { ok: false, error: `LLM gagal: ${err.message}` };
  }

  if (!parsed || parsed.valid === false || !parsed.program) {
    // F1.4: jangan menebak isi — skip.
    return { ok: false, error: 'Konten tidak dapat distrukturkan sebagai info bansos.' };
  }

  // Filter relevansi: tolak yang BUKAN program bansos (lowongan kerja, lelang, alat, berita).
  if (parsed.relevan_bansos === false || (parsed.jenis_konten && parsed.jenis_konten !== 'program_bansos')) {
    return { ok: false, error: `Bukan program bansos (jenis: ${parsed.jenis_konten || 'tak relevan'}) — dilewati.` };
  }

  const wilayah = normalizeWilayahTag(parsed.wilayah_tag || hintWilayah) || 'nasional';
  return {
    ok: true,
    data: {
      program: parsed.program,
      ringkasan: parsed.ringkasan_bahasa_sederhana || '',
      syarat: Array.isArray(parsed.syarat) ? parsed.syarat : [],
      tanggal_penting: parsed.tanggal_penting || null,
      batas_daftar: parsed.batas_daftar || null,
      cara_daftar: parsed.cara_daftar || null,
      wilayah_tag: wilayah,
      sumber_url: sumberUrl || null,
    },
  };
}
