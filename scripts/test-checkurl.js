// Tes inspectUrl (unit) + tool cek_url via brain (integrasi). Jalankan: node scripts/test-checkurl.js
import { inspectUrl } from '../src/agent2/checkurl.js';

const show = (label, r) => {
  console.log('─'.repeat(68));
  console.log('▶', label);
  console.log('  ', JSON.stringify(r, null, 0));
};

const run = async () => {
  // 1) SSRF guard
  show('SSRF localhost (harus ok:false)', await inspectUrl('http://localhost:3210/admin'));
  show('SSRF IP privat (harus ok:false)', await inspectUrl('http://192.168.1.1'));

  // 2) Skema salah
  show('bukan http (harus ok:false)', await inspectUrl('ftp://contoh.com'));

  // 3) Domain resmi (sinyal is_official_gov walau mungkin unreachable)
  show('kemensos.go.id (is_official_gov:true)', await inspectUrl('https://kemensos.go.id'));

  // 4) Redirect chain (http→https)
  show('redirect github (chain terisi)', await inspectUrl('http://github.com'));

  // 5) Domain mirip resmi tapi bukan .go.id (lookalike)
  show('lookalike (domain_mirip_resmi:true)', await inspectUrl('https://kemensos-bansos-cair.web.id/login'));

  // 6) URL mati
  show('domain ngaco (unreachable)', await inspectUrl('https://situs-ngaco-tidak-ada-xyz123.com'));

  console.log('─'.repeat(68));
  console.log('Selesai. (cek manual: ok, redirect_chain, is_official_gov, domain_mirip_resmi, minta_data_sensitif, is_download)');
};

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
