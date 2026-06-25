# Uji Validitas Jawaban Warta Warga (vs Google AI / sumber asli)

**Diperbarui:** 25 Jun 2026 · **KB saat ini:** 12 entri bersih (lihat lampiran).
Tujuan: cek apakah jawaban bot **akurat & benar-benar bersumber** (grounded) dari URL yang dikutipnya.

## Cara pakai
1. Untuk tiap baris, buka **Sumber** yang bot kutip → baca isinya.
2. Tanyakan hal yang sama ke **Google AI / sumber resmi** → isi kolom *Jawaban Google AI*.
3. Isi **Cocok?** dengan salah satu:
   - ✅ **Grounded** = isi jawaban bot sesuai isi sumber yang dikutip.
   - ⚠️ **Beda** = ada selisih fakta antara jawaban bot dan sumber/Google AI.
   - ➖ **Di luar cakupan** = bot jujur bilang "belum ada di sumber resmi" (BUKAN salah — ini desain anti-hoaks).

> ⚖️ **Penting saat menilai:** Warta Warga **sengaja hanya menjawab dari sumber terkurasi** dan menolak mengarang. Jadi kalau Google AI menyebut program yang bot bilang "belum ada infonya", itu **bukan berarti bot salah** — itu soal *cakupan KB*, bukan *akurasi*. Yang dinilai SALAH hanya bila bot **mengklaim** fakta yang **tidak cocok** dengan sumber yang ia kutip.

---

## Tabel uji (jawaban bot sudah diisi otomatis — tinggal isi 2 kolom kanan)

| # | Pertanyaan | Jawaban bot (ringkas) | Sumber utama dikutip | Jawaban Google AI | Cocok? |
|---|------------|------------------------|----------------------|-------------------|--------|
| 1 | Apa itu PKH dan apa syaratnya? | Bantuan tunai bersyarat dari Kemensos utk keluarga miskin/rentan terdaftar DTKS; ada komponen (ibu hamil, anak sekolah, lansia, disabilitas). | kemensos.go.id/program-bantuan-sosial/pkh | | |
| 2 | Berapa nominal Program Sembako/bulan? | Rp200.000/bulan, dibelanjakan pangan (beras, telur, dll) lewat kartu elektronik di e-warong. | kemensos.go.id/program-bantuan-sosial/sembako | | |
| 3 | Syarat dapat PIP apa aja? | Usia 6–21 th; keluarga miskin/rentan (diutamakan pemegang KIP/DTKS); terdaftar sbg siswa. | pip.kemdikbud.go.id | | |
| 4 | PBI-JKN itu apa? | Penerima Bantuan Iuran JKN — iuran BPJS Kesehatan kelas 3 dibayari pemerintah utk warga kurang mampu (DTKS). | kemensos.go.id/pbi-jkn | | |
| 5 | Ada bansos khusus di Kab. Bekasi? | BANPIN (Beasiswa Pasti Pintar) usia 16–30 th + Bansos anak/disabilitas/lansia telantar. | banpin.bekasikab.go.id, dinsos.bekasikota.go.id | | |
| 6 | Bantuan rumah tidak layak huni di Purwakarta? | Rutilahu Rp20jt/rumah (realisasi 300 rumah) — bot menandai info lama & sarankan cek ulang. | ppid.purwakartakab.go.id/news/...rutilahu | | |
| 7 | Bansos di Banyumas apa aja? | Z-Mart BAZNAS Banyumas — modal usaha untuk mustahik (2026: Rp800jt utk 100 titik). | kabbanyumas.baznas.go.id | | |
| 8 | Apakah saya pasti dapat bansos? | **Tidak memvonis:** minta cari info dulu, tanya daerah; kelayakan tergantung DTKS, sarankan cek cekbansos / RT-RW. | (tanya balik dulu) | | |
| 9 | Ada bantuan Rp10jt tinggal klik link, benar? | 🚨 **Penipuan** — tidak ada program resmi cair via klik link; bansos resmi lewat pendataan RT/RW, bukan link. | (dinilai dari sumber + pola) | | |
| 10 | BLT BBM masih ada nggak? | **Jujur:** belum ada info resmi terbaru kelanjutannya; sempat ada 2022 sbg kompensasi BBM; tawarkan PKH/Sembako. | (tidak ada — di luar cakupan) | | |

---

## Catatan & temuan (sudah diperbaiki vs versi lama)

- ✅ **#1 PKH kini mengutip kemensos** (`kemensos.go.id/program-bantuan-sosial/pkh`), bukan lagi reproduksi kota (Banjarmasin). Penyebab lama (duplikat PKH lintas sumber) sudah dirapikan.
- ✅ **Sumber berita dibersihkan.** Filter relevansi dipertajam: artikel berita/siaran pers yang sekadar *menyebut* program (mis. `dewanekonomi.go.id`, dinsos kota) kini **ditolak** (jenis_konten=berita_umum). KB 100% halaman program, bukan berita.
- ✅ **Duplikat dihapus.** PKH & Sembako nasional kini satu entri kanonik masing-masing.
- ✅ **Program nasional bertambah** lewat hub-crawl halaman utama kemensos: **RST (Rumah Sejahtera Terpadu)** & **ATENSI** kini masuk KB dari halaman resmi `/program-bantuan-sosial/*`.
- **Hal yang tetap BENAR (poin plus):**
  - #6 menandai info lama (2022) → fitur "masa berlaku" bekerja.
  - #7 menjawab program daerah nyata (Z-Mart BAZNAS) — bukan karangan.
  - #8 tidak menjanjikan kepastian penerima (malah cari info dulu / tanya daerah).
  - #9 klaim hoaks → tegas penipuan + edukasi.
  - #10 jujur "belum ada info resmi terbaru".

## Lampiran — isi KB saat ini (12 entri, semua sumber resmi nyata)
**Nasional (6):** PKH, Program Sembako, RST, ATENSI (semua `kemensos.go.id/program-bantuan-sosial/*`); PBI-JKN (`kemensos.go.id/pbi-jkn`); PIP (`pip.kemdikbud.go.id`).
**Kab. Bekasi (2):** BANPIN (`banpin.bekasikab.go.id`), Bansos Anak/Disabilitas/Lansia Telantar (`dinsos.bekasikota.go.id`).
**Kab. Purwakarta (3):** PKH (`purwakartakab.go.id/read/145`), Rutilahu (`ppid.purwakartakab.go.id`), BST APBD (`purwakartakab.go.id/read/1270`).
**Kab. Banyumas (1):** Z-Mart BAZNAS (`kabbanyumas.baznas.go.id`).
