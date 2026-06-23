# Uji Validitas Jawaban Warta Warga (vs Google AI / sumber asli)

**Dibuat:** 23 Jun 2026 · **KB saat ini:** 13 entri (lihat lampiran).
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

| # | Pertanyaan | Jawaban bot (ringkas) | Sumber dikutip | Jawaban Google AI | Cocok? |
|---|------------|------------------------|----------------|-------------------|--------|
| 1 | Apa itu PKH dan apa syaratnya? | Bantuan tunai bersyarat utk keluarga DTKS; cair 4x/thn; syarat: terdaftar DTKS, keluarga miskin/rentan, ada komponen (ibu hamil, anak sekolah, lansia 60+, disabilitas), anak wajib sekolah & rutin Posyandu. | dinsos.banjarmasinkota.go.id/p/pkh-program-keluarga-harapan.html | | |
| 2 | Berapa nominal Program Sembako/bulan? | Rp200.000/bulan, dibelanjakan pangan di e-warong pakai KKS. | kemensos.go.id/bantuan-pangan-non-tunai | | |
| 3 | Syarat dapat PIP apa aja? | Usia 6–21 th; keluarga miskin/rentan (diutamakan pemegang KIP/DTKS); terdaftar sbg siswa. | pip.kemdikbud.go.id | | |
| 4 | PBI-JKN itu apa? | Iuran BPJS Kesehatan kelas 3 ditanggung negara utk warga kurang mampu. | kemensos.go.id/pbi-jkn | | |
| 5 | Ada bansos khusus di Kab. Bekasi? | BANPIN (Beasiswa Pasti Pintar) usia 16–30 th, jalur akademik & non-akademik; daftar online. | banpin.bekasikab.go.id | | |
| 6 | Bantuan rumah tidak layak huni di Purwakarta? | Rutilahu Rp20jt/rumah utk 300 rumah — **bot menandai info dari 2022 & menyarankan cek ulang**. | ppid.purwakartakab.go.id/news/...rutilahu | | |
| 7 | Bansos di Banyumas apa aja? | **Jujur:** belum ada program KHUSUS Banyumas; arahkan ke program nasional (PKH, Sembako, PBI-JKN) + cek DTKS. | kemensos.go.id/program-keluarga-harapan, /pbi-jkn | | |
| 8 | Apakah saya pasti dapat bansos? | **Tidak memvonis:** kelayakan tergantung DTKS; sarankan cek cekbansos / RT-RW. | kemensos.go.id/program-keluarga-harapan | | |
| 9 | Ada bantuan Rp10jt tinggal klik link, benar? | ⚠️ **Belum bisa dipastikan** — tidak ada di sumber resmi; peringatan waspada tautan penipuan. | (tidak ada) | | |
| 10 | BLT BBM masih ada nggak? | **Jujur:** tidak ada info resmi kelanjutannya; biasanya sementara/berakhir; tawarkan PKH/Sembako. | purwakartakab.go.id/read/145, kemensos.go.id/program-sembako | | |

---

## Catatan & temuan (yang perlu kamu tahu saat menilai)

- **#1 PKH → sumber Banjarmasin.** Untuk pertanyaan PKH umum, bot mengutip `dinsos.banjarmasinkota.go.id` (reproduksi PKH oleh sebuah kota), bukan halaman kemensos. Isinya tentang PKH dan akurat, tapi idealnya sumber program **nasional** ya dari kemensos. Penyebab: ada beberapa entri PKH di KB (lihat lampiran) dan yang dari Banjarmasin isinya paling "kaya" sehingga menang ranking.
- **Entri berita nasional yang lolos filter:** ada 2 entri yang sebenarnya artikel **berita**, bukan halaman program: `dewanekonomi.go.id/...digitalisasi-bansos...` dan `dinsos.banjarmasinkota.go.id/...`. Keduanya menyebut PKH/Sembako sehingga lolos filter "program bernama". Bisa dipertimbangkan untuk dihapus agar sumber 100% bersih.
- **Duplikat PKH:** ada 3 entri PKH nasional (`/program-keluarga-harapan`, `/program-keluarga-harapan-2`, Banjarmasin). Bisa dirapikan jadi satu (kemensos).
- **Hal yang sudah BENAR (poin plus untuk dinilai):**
  - #6 menandai info lama (2022) → fitur "masa berlaku" bekerja.
  - #7 jujur "belum ada khusus daerah" → tidak mengarang (sumber daerah karangan sudah dihapus).
  - #8 tidak menjanjikan kepastian penerima.
  - #9 klaim hoaks → label ⚠️ + peringatan tautan.
  - #10 jujur "belum ada info resmi".

## Lampiran — isi KB saat ini (13 entri)
**Nasional:** PKH (×3: kemensos /program-keluarga-harapan, /-2, + Banjarmasin), BPNT/Sembako (kemensos), PIP (pip.kemdikbud), PBI-JKN (kemensos), Sembako (kemensos /program-sembako), + 1 berita digitalisasi (dewanekonomi).
**Kab. Bekasi:** Bansos Anak/Disabilitas/Lansia Telantar (dinsos.bekasikota), BANPIN (banpin.bekasikab).
**Kab. Purwakarta:** PKH (purwakartakab/read/145), Rutilahu (ppid.purwakartakab), BST APBD (purwakartakab/read/1270).
