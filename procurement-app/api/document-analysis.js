const pdf = require('pdf-parse');

const MAX_DOCUMENTS = 3;
const MAX_BYTES = 8 * 1024 * 1024;
const MATERIAL_RULES = [
  { material: 'геотекстиль', patterns: ['геотекстил', 'геотканин'] },
  { material: 'ПВХ-мембрана', patterns: ['пвх-мембран', 'pvc мембран'] },
  { material: 'дренажна мембрана', patterns: ['дренажн'] },
  { material: 'гідроізоляційна мембрана', patterns: ['гідроізоляц', 'гідромембран', 'бітумн'] },
  { material: 'покрівельна мембрана', patterns: ['покрівельн мембран', 'рулонн покрів'] }
];

function validTenderId(value) {
  return /^[a-f0-9]{32}$/i.test(value || '');
}

function publicPdfDocuments(data) {
  return (data.documents || []).filter((document) => {
    const format = (document.format || '').toLowerCase();
    const title = (document.title || '').toLowerCase();
    return document.url && (format.includes('pdf') || title.endsWith('.pdf'));
  }).slice(0, MAX_DOCUMENTS);
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractCharacteristics(snippet) {
  const matches = snippet.match(/\b\d+(?:[.,]\d+)?\s*(?:мм|см|м²|м2|г\/м²|г\/м2|кг\/м²|кг\/м2|кг|м3|м³|%|МПа)\b/giu) || [];
  return [...new Set(matches)].slice(0, 8).join('; ');
}

function findingsFromText(text) {
  const normalized = compactText(text).toLowerCase();
  return MATERIAL_RULES.flatMap((rule) => {
    const position = rule.patterns.map((pattern) => normalized.indexOf(pattern)).find((index) => index >= 0);
    if (position === undefined) return [];

    const snippet = compactText(text.slice(Math.max(0, position - 260), position + 620));
    return [{
      material: rule.material,
      excerpt: snippet,
      characteristics: extractCharacteristics(snippet),
      confidence: 'Потрібно перевірити'
    }];
  });
}

async function analyzeDocument(document) {
  try {
    const response = await fetch(document.url, { headers: { Accept: 'application/pdf' } });
    if (!response.ok) throw new Error(`Документ недоступний (${response.status})`);

    const size = Number(response.headers.get('content-length') || 0);
    if (size > MAX_BYTES) throw new Error('Файл більший за 8 МБ');

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error('Файл більший за 8 МБ');
    if (bytes.subarray(0, 4).toString('ascii') !== '%PDF') {
      throw new Error('За посиланням Prozorro повернувся не PDF-файл');
    }

    const parsed = await pdf(bytes, { max: 25 });
    const text = compactText(parsed.text);
    if (!text) {
      return {
        title: document.title || 'Документ Prozorro',
        url: document.url,
        status: 'Потрібно перевірити',
        reason: 'PDF не містить текстового шару — ймовірно, це скан. Автоматичний аналіз не робить висновку; відкрийте документ або застосуйте OCR.',
        findings: []
      };
    }

    return {
      title: document.title || 'Документ Prozorro',
      url: document.url,
      status: 'Проаналізовано',
      textLength: text.length,
      findings: findingsFromText(text)
    };
  } catch (error) {
    return {
      title: document.title || 'Документ Prozorro',
      url: document.url,
      status: 'Потрібно перевірити',
      reason: error.message || 'Не вдалося прочитати документ',
      findings: []
    };
  }
}

module.exports = async (request, response) => {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const tenderId = request.query?.tenderId;
  if (!validTenderId(tenderId)) {
    response.status(400).json({ error: 'Некоректний ідентифікатор закупівлі' });
    return;
  }

  try {
    const tenderResponse = await fetch(`https://public-api.prozorro.gov.ua/api/2.5/tenders/${tenderId}`, {
      headers: { Accept: 'application/json' }
    });
    if (!tenderResponse.ok) throw new Error(`Prozorro відповів кодом ${tenderResponse.status}`);

    const { data } = await tenderResponse.json();
    const documents = publicPdfDocuments(data);
    const analysis = await Promise.all(documents.map(analyzeDocument));
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    response.status(200).json({
      tenderId,
      analyzedDocuments: analysis,
      message: analysis.length
        ? `Перевірено PDF-документів: ${analysis.length}`
        : 'У Prozorro не знайдено доступних PDF-документів для цієї закупівлі.'
    });
  } catch (error) {
    response.status(502).json({ error: error.message || 'Не вдалося проаналізувати документи Prozorro' });
  }
};
