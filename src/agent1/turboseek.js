import axios from 'axios';

const BASE_URL = 'https://www.turboseek.io/api';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function cleanText(text) {
  if (!text) return '';
  let cleaned = String(text);
  cleaned = cleaned.replace(/[\n\r\t]+/g, ' ');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  cleaned = cleaned.replace(/<[^>]*>/g, '');
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  cleaned = cleaned.replace(/^#+\s*/gm, '');
  cleaned = cleaned.replace(/^[•·\-*]\s*/gm, '');
  return cleaned.trim();
}

function cleanHtml(html) {
  if (!html) return '';
  let text = String(html);
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/[\n\r\t]+/g, ' ');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/\s{2,}/g, ' ');
  return text.trim();
}

async function postJson(path, payload) {
  const url = `${BASE_URL}/${path}`;
  const res = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    timeout: 30000,
  });
  return res.data;
}

async function getSources(query) {
  const data = await postJson('getSources', { question: query });
  if (Array.isArray(data)) return data;
  if (data?.sources) return data.sources;
  return [];
}

async function getAnswer(query, sources) {
  const data = await postJson('getAnswer', { question: query, sources });
  return String(data || '');
}

export async function searchTurboseek(query) {
  const rawSources = await getSources(query);
  const filtered = rawSources
    .map((source) => ({
      title: String(source.title || '').trim(),
      content: String(source.content || '').trim(),
      url: String(source.url || '').trim(),
    }))
    .filter((source) => {
      if (!source.url) return false;
      const lowerTitle = source.title.toLowerCase();
      if (source.url.includes('.pdf') || source.url.includes('journal') || source.url.includes('ac.id')) return false;
      if (lowerTitle.includes('jurnal') || lowerTitle.includes('vol.') || lowerTitle.includes('issn') || lowerTitle.includes('klasifikasi')) return false;
      if (source.content.length < 100) return false;
      return true;
    });

  const sources = filtered.map((source) => ({
    title: cleanText(source.title),
    url: source.url,
    content: source.content,
  }));

  let answer = '';
  try {
    answer = await getAnswer(query, sources);
  } catch {
    answer = '';
  }

  return {
    success: sources.length > 0,
    query,
    answer: cleanHtml(answer),
    sources,
  };
}
