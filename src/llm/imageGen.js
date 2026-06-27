import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { config, ROOT } from '../config.js';

/**
 * Generate a visual prompt optimized for ChatGPT image model based on bansos information.
 */
function buildBansosPrompt(record) {
  const host = record.sumber_url ? new URL(record.sumber_url).hostname : 'Government Institution';
  return `Create a warm, clean, professional poster/infographic about a government social aid program in Indonesia.
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
- No complex or messy text inside the graphic to prevent spelling errors.
- Include simple symbolic metaphors (e.g., hands receiving help, or a checklist/calendar indicating schedules, or showing steps to visit a government office/submit documents).
- If the design includes the 'Garuda Pancasila' (the national emblem of Indonesia / Burung Garuda), it must strictly follow the official, correct national standard form (golden eagle, head facing to its right, chest shield with Pancasila symbols, talons gripping the 'Bhinneka Tunggal Ika' ribbon). Do not morph it into any other creative form, generic eagle, or bird.
- Safe for elderly and general community viewing.`;
}

/**
 * Call the OpenAI-compatible endpoint to generate an image and save it locally using the official SDK.
 * @param {object} record info record containing program, ringkasan, etc.
 * @returns {Promise<string|null>} absolute path to the saved image file, or null if failed.
 */
export async function generateAndSavePoster(record) {
  const apiKey = config.images.apiKey;
  const baseUrl = config.images.baseUrl;
  const model = config.images.model;

  if (!apiKey) {
    console.log('[ImageGen] ⚠️ API key not set for image generation. Skipping image creation.');
    return null;
  }

  const prompt = buildBansosPrompt(record);
  console.log(`[ImageGen] Generating poster for program: "${record.program}" using model: "${model}" via OpenAI SDK...`);

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

    const fileName = `info_${record.id || Date.now()}.png`;
    const filePath = path.join(dirPath, fileName);
    
    const buffer = Buffer.from(b64, 'base64');
    fs.writeFileSync(filePath, buffer);

    console.log(`[ImageGen] ✅ Saved generated poster to: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error(`[ImageGen] ❌ Error generating image: ${err.message}`);
    return null;
  }
}
