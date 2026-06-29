import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { config, ROOT } from '../config.js';

/**
 * Generate a visual prompt optimized for ChatGPT image model based on bansos information.
 */
function buildBansosPrompt(record) {
  let host = 'Government Institution';
  try {
    if (record.sumber_url) host = new URL(record.sumber_url).hostname;
  } catch {
    host = 'Government Institution';
  }
  const imageId = record.image_id || (record.id ? `info_${record.id}` : '');
  return `Create a warm, clean, professional poster/infographic about a government social aid program in Indonesia.
Internal poster ID: ${imageId || 'not assigned'}
Program name: "${record.program}"
Description: ${record.ringkasan || ''}
How to register/claim: ${record.cara_daftar || 'Not specified (contact local RT/RW office)'}
Institution providing this info: ${host}
Source URL: ${record.sumber_url || ''}
Target: Indonesian citizens and families in need.

Visual style:
- Warm, patient, and trustworthy illustration.
- Clean vector art style, minimalist layout.
- Solid background color (such as soft blue, green, or light gray).
- Keep text inside the graphic minimal: use the exact program name as the main heading and the short ID "${imageId || 'INFO'}" as a small footer label.
- Include simple symbolic metaphors (e.g., hands receiving help, or a checklist/calendar indicating schedules, or showing steps to visit a government office/submit documents).
- If the design includes the 'Garuda Pancasila' (the national emblem of Indonesia / Burung Garuda), it must strictly follow the official, correct national standard form (golden eagle, head facing to its right, chest shield with Pancasila symbols, talons gripping the 'Bhinneka Tunggal Ika' ribbon). Do not morph it into any other creative form, generic eagle, or bird.
- Safe for elderly and general community viewing.`;
}

function safeAssetId(record, explicitImageId) {
  const raw = explicitImageId || record.image_id || (record.id ? `info_${record.id}` : `info_${Date.now()}`);
  return String(raw)
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || `info_${Date.now()}`;
}

/**
 * Call the OpenAI-compatible endpoint to generate an image and save it locally using the official SDK.
 * @param {object} record info record containing program, ringkasan, etc.
 * @returns {Promise<string|null>} absolute path to the saved image file, or null if failed.
 */
/**
 * Generate a warning poster for a cluster of penipuan/misinformasi reports.
 * @param {{ kategori:string, wilayah:string, total:number, deskripsi:string, imageId?:string }} opts
 * @returns {Promise<string|null>} absolute path to saved image, or null if failed.
 */
export async function generatePeringatanPoster({ kategori, wilayah, total, deskripsi, imageId } = {}) {
  const apiKey = config.images.apiKey;
  const baseUrl = config.images.baseUrl;
  const model = config.images.model;
  const assetId = safeAssetId({}, imageId || `peringatan_${Date.now()}`);

  if (!apiKey) {
    console.log('[ImageGen] ⚠️ API key not set — skipping peringatan poster.');
    return null;
  }

  const prompt = `Create a bold, clear WARNING poster in Indonesian for community safety awareness.
Warning type: ${kategori} (fraud / misinformation alert)
Region: ${wilayah}
Reports received: ${total} warga melaporkan kasus serupa
Summary: ${deskripsi}

Visual style:
- Prominent red/orange warning palette with strong contrast
- Large bold "⚠️ PERINGATAN" heading at top
- Indonesian language throughout
- Clean modern infographic layout
- Include icons: shield, warning triangle, community
- Safety tips section: "Jangan transfer uang / kasih OTP / klik link mencurigakan"
- Footer: "Terverifikasi Admin Warta Warga"
- Professional, urgent, trustworthy — suitable for WhatsApp broadcast`;

  console.log(`[ImageGen] Generating peringatan poster for ${kategori} di ${wilayah} (${total} laporan)...`);
  try {
    const openai = new OpenAI({ apiKey, baseURL: baseUrl });
    const result = await openai.images.generate({ model, prompt });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) { console.warn('[ImageGen] ❌ No b64_json returned.'); return null; }

    const dirPath = path.join(ROOT, 'data', 'posters');
    fs.mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, `${assetId}.png`);
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
    console.log(`[ImageGen] ✅ Saved peringatan poster: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error(`[ImageGen] ❌ Peringatan poster failed: ${err.message}`);
    return null;
  }
}

export async function generateAndSavePoster(record, { imageId } = {}) {
  const apiKey = config.images.apiKey;
  const baseUrl = config.images.baseUrl;
  const model = config.images.model;
  const assetId = safeAssetId(record, imageId);
  const promptRecord = { ...record, image_id: assetId };

  if (!apiKey) {
    console.log('[ImageGen] ⚠️ API key not set for image generation. Skipping image creation.');
    return null;
  }

  const prompt = buildBansosPrompt(promptRecord);
  console.log(`[ImageGen] Generating poster ${assetId} for program: "${record.program}" using model: "${model}" via OpenAI SDK...`);

  try {
    const openai = new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });

    const result = await openai.images.generate({
      model,
      prompt,
    });

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) {
      console.warn('[ImageGen] ❌ No image b64_json returned in API response.');
      return null;
    }

    const dirPath = path.join(ROOT, 'data', 'posters');
    fs.mkdirSync(dirPath, { recursive: true });

    const fileName = `${assetId}.png`;
    const filePath = path.join(dirPath, fileName);
    
    const buffer = Buffer.from(b64, 'base64');
    fs.writeFileSync(filePath, buffer);
    fs.writeFileSync(
      path.join(dirPath, `${assetId}.json`),
      JSON.stringify(
        {
          image_id: assetId,
          info_id: record.id || null,
          program: record.program,
          wilayah_tag: record.wilayah_tag || null,
          sumber_url: record.sumber_url || null,
          generated_at: new Date().toISOString(),
          model,
          prompt,
        },
        null,
        2,
      ),
    );

    console.log(`[ImageGen] ✅ Saved generated poster to: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error(`[ImageGen] ❌ Error generating image: ${err.message}`);
    return null;
  }
}
