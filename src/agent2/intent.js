// Deteksi intent deterministik — pisahkan verifikasi hoaks vs lapor aduan vs info bansos
// sebelum intercept lapor-layanan mencuri pesan ke brain.

const VERIFICATION_INTENT =
  /\b(apakah|benarkah|beneran|bener\s*gak|benar\s*gak|asli\s*gak|asli\s*nggak|hoaks|hoax|palsu|tipu|penipuan\s*gak|penipuan\s*nggak|aman\s*gak|aman\s*nggak|cek\s*in(i|i)?|validasi|verifikasi|misinformasi|disinformasi|berita\s*bohong)\b/i;

const REPORT_INTENT = /\b(lapor|aduan|pengaduan|adukan|ngadu|mohon\s*lapor|tolong\s*lapor|ingin\s*lapor|mau\s*lapor)\b/i;

const QUESTION_MARK = /\?|gak\s*ya|nggak\s*ya|kan\s*ya|bukan\s*ya/i;

/** Warga menanyakan kebenaran info/link/gambar — ke brain (JagaWarga), bukan alur aduan. */
export function isVerificationIntent(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (VERIFICATION_INTENT.test(s)) return true;
  // "ini bener?" / "aman nih?" tanpa kata kunci eksplisit
  if (QUESTION_MARK.test(s) && /\b(ini|itu|link|url|gambar|foto|pesan|info|kabar|berita)\b/i.test(s)) return true;
  return false;
}

/** Warga ingin melaporkan ke portal / pipeline — boleh intercept lapor-layanan. */
export function isReportIntent(text) {
  return REPORT_INTENT.test(String(text || ''));
}

/** Gambar tanpa caption → default verifikasi, kecuali OCR jelas niat lapor. */
export function isImageOnlyVerificationDefault({ text, imageText }) {
  const caption = String(text || '').trim();
  if (caption) return isVerificationIntent(caption) && !isReportIntent(caption);
  const ocr = String(imageText || '').trim();
  if (!ocr) return true;
  if (isReportIntent(ocr) && !isVerificationIntent(ocr)) return false;
  return !isReportIntent(ocr) || isVerificationIntent(ocr);
}
