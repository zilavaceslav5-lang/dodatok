const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const MAX_DOCUMENTS = 5;
const MAX_BYTES = 8 * 1024 * 1024;
const MATERIAL_RULES = [
  { material: 'геотекстиль', patterns: ['геотекстил', 'геотканин'] },
  { material: 'ПВХ-мембрана', patterns: ['пвх-мембран', 'pvc мембран'] },
  { material: 'дренажна мембрана', patterns: ['дренажн'] },
  { material: 'гідро- і пароізоляція', patterns: ['гідроізоляц', 'гідромембран', 'пароізоляц', 'гідробар', 'вітробар', 'рубероїд', 'бітумн мастик'] },
  { material: 'покрівельна мембрана', patterns: ['покрівельн мембран', 'рулонн покрів'] },
  { material: 'теплоізоляція / мінеральна вата', patterns: ['мінеральн ват', 'мінераловат', 'базальтов', 'скловат', 'теплоізоляц', 'утеплювач', 'пінополістирол', 'екструдован'] },
  { material: 'фасадна склосітка', patterns: ['склосіт', 'армувальн сіт'] },
  { material: 'водостічна система', patterns: ['водостічн'] },
  { material: 'труби ПВХ / ПП / ПЕ', patterns: ['труба пвх', 'труби пвх', 'труба пп', 'труби пп', 'поліпропіленов', 'поліетиленов', 'труба пе', 'пе 100'] }
];
const SUPPORTED_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'xls', 'ods', 'csv', 'tsv', 'txt', 'json', 'xml', 'html', 'htm', 'rtf']);

function validTenderId(value) { return /^[a-f0-9]{32}$/i.test(value || ''); }

function documentFormat(document) {
  const mime = String(document.format || '').toLowerCase();
  const name = `${document.title || ''} ${document.url || ''}`.toLowerCase();
  const extension = name.match(/\.([a-z0-9]+)(?:[?#\s]|$)/i)?.[1] || '';
  if (extension) return extension;
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('wordprocessingml')) return 'docx';
  if (mime.includes('spreadsheetml')) return 'xlsx';
  if (mime.includes('opendocument.spreadsheet')) return 'ods';
  if (mime.includes('csv')) return 'csv';
  if (mime.includes('json')) return 'json';
  if (mime.includes('xml')) return 'xml';
  if (mime.includes('html')) return 'html';
  if (mime.includes('text')) return 'txt';
  return '';
}

function documentPriority(document) {
  const title = String(document.title || '').toLowerCase();
  if (/технічн.{0,12}завдан/.test(title)) return 0;
  if (/відоміст.{0,20}(обсяг|робіт)/.test(title)) return 1;
  if (/відоміст.{0,20}ресурс/.test(title)) return 2;
  if (/(специфікац|локальн.{0,12}кошторис|кошторис)/.test(title)) return 3;
  return 10;
}

function publicMachineReadableDocuments(data) {
  return (data.documents || [])
    .filter((document) => document.url && SUPPORTED_FORMATS.has(documentFormat(document)))
    .sort((left, right) => documentPriority(left) - documentPriority(right))
    .slice(0, MAX_DOCUMENTS);
}

function compactText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
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
    return [{ material: rule.material, excerpt: snippet, characteristics: extractCharacteristics(snippet), confidence: 'Потрібно перевірити' }];
  });
}
function textFromMarkup(value) {
  return String(value).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&(nbsp|amp|lt|gt|quot);/g, ' ');
}
async function extractText(bytes, format) {
  if (format === 'pdf') {
    if (bytes.subarray(0, 4).toString('ascii') !== '%PDF') throw new Error('За посиланням Prozorro повернувся не PDF-файл');
    return (await pdf(bytes, { max: 25 })).text;
  }
  if (format === 'docx') return (await mammoth.extractRawText({ buffer: bytes })).value;
  if (['xlsx', 'xls', 'ods'].includes(format)) {
    const workbook = XLSX.read(bytes, { type: 'buffer' });
    return workbook.SheetNames.map((name) => `${name}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`).join('\n');
  }
  const raw = bytes.toString('utf8');
  if (format === 'html' || format === 'htm' || format === 'xml') return textFromMarkup(raw);
  if (format === 'rtf') return raw.replace(/\\[a-z]+-?\d* ?/gi, ' ').replace(/[{}]/g, ' ');
  return raw;
}

async function analyzeDocument(document) {
  const format = documentFormat(document);
  try {
    const response = await fetch(document.url, { headers: { Accept: 'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/*,*/*' } });
    if (!response.ok) throw new Error(`Документ недоступний (${response.status})`);
    const size = Number(response.headers.get('content-length') || 0);
    if (size > MAX_BYTES) throw new Error('Файл більший за 8 МБ');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error('Файл більший за 8 МБ');
    const text = compactText(await extractText(bytes, format));
    if (!text) return {
      title: document.title || 'Документ Prozorro', url: document.url, format, status: 'Потрібно перевірити', findings: [],
      reason: format === 'pdf' ? 'PDF не містить текстового шару — ймовірно, це скан. Автоматичний аналіз не робить висновку; відкрийте документ або застосуйте OCR.' : 'У документі не знайдено доступного тексту; перевірте його вручну.'
    };
    return { title: document.title || 'Документ Prozorro', url: document.url, format, status: 'Проаналізовано', textLength: text.length, findings: findingsFromText(text) };
  } catch (error) {
    return { title: document.title || 'Документ Prozorro', url: document.url, format, status: 'Потрібно перевірити', reason: error.message || 'Не вдалося прочитати документ', findings: [] };
  }
}

module.exports = async (request, response) => {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET'); response.status(405).json({ error: 'Method not allowed' }); return;
  }
  const tenderId = request.query?.tenderId;
  if (!validTenderId(tenderId)) { response.status(400).json({ error: 'Некоректний ідентифікатор закупівлі' }); return; }
  try {
    const tenderResponse = await fetch(`https://public-api.prozorro.gov.ua/api/2.5/tenders/${tenderId}`, { headers: { Accept: 'application/json' } });
    if (!tenderResponse.ok) throw new Error(`Prozorro відповів кодом ${tenderResponse.status}`);
    const { data } = await tenderResponse.json();
    const analysis = await Promise.all(publicMachineReadableDocuments(data).map(analyzeDocument));
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    response.status(200).json({ tenderId, analyzedDocuments: analysis, message: analysis.length ? `Перевірено машиночитаних документів: ${analysis.length}` : 'У Prozorro не знайдено підтримуваних машиночитаних документів для цієї закупівлі.' });
  } catch (error) { response.status(502).json({ error: error.message || 'Не вдалося проаналізувати документи Prozorro' }); }
};
