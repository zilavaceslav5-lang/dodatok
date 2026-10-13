/**
 * Vercel serverless endpoint for the public Prozorro tender feed.
 * It deliberately contains no credentials: Prozorro's public API is queried
 * only when a client requests /api/prozorro.
 */
// General repair or construction is not enough evidence of a MIZOL sales
// opportunity.  The terms below are deliberately limited to envelope,
// insulation, waterproofing, roofing and drainage work/materials.
const TITLE_RELEVANCE_TERMS = [
  'геотекстил', 'геотканин', 'мембран', 'гідроізоляц', 'гідромембран',
  'покрів', 'рулонн покрів', 'утеплен', 'теплоізоляц', 'термоізоляц',
  'дренаж', 'фундамент', 'відмостк', 'водовідвед'
];

// CPV / ДК 021:2015 classes that are materially connected to the above work.
// A generic capital-repair code is intentionally not sufficient.
const TARGET_DK_PREFIXES = ['4411', '4526', '4532'];

const MATERIAL_RULES = [
  { material: 'геотекстиль', patterns: ['геотекстил', 'геотканин'] },
  { material: 'ПВХ-мембрана', patterns: ['пвх-мембран', 'pvc мембран'] },
  { material: 'дренажна мембрана', patterns: ['дренажн'] },
  { material: 'гідроізоляційна мембрана', patterns: ['гідроізоляц', 'гідромембран'] },
  { material: 'покрівельна мембрана', patterns: ['покрівельн мембран', 'рулонн покрів'] }
];

// Sales coverage is deliberately limited to the regions agreed for this
// workspace. We use both `region` and `locality`, because Prozorro records
// are not always populated consistently. A tender with no usable delivery
// location is excluded rather than being silently treated as in-scope.
const TARGET_AREA_LABELS = [
  ['Київ / Київська область', ['київ', 'киев', 'kyiv']],
  ['Чернігівська область', ['черніг', 'chernih']],
  ['Черкаська область', ['черкас', 'cherkas']],
  ['Житомирська область', ['житомир', 'zhytomyr']]
];

function normalizeLocation(value) {
  return String(value || '').toLowerCase().replace(/[’'`]/g, '').trim();
}

function deliveryAddresses(data) {
  return [data.deliveryAddress, ...(data.items || []).map((item) => item.deliveryAddress)]
    .filter((address) => address && (address.region || address.locality))
    .map((address) => ({
      region: address.region || '',
      locality: address.locality || ''
    }));
}

function targetAreaFor(address) {
  const location = normalizeLocation(`${address.region} ${address.locality}`);
  return TARGET_AREA_LABELS.find(([, terms]) => terms.some((term) => location.includes(term)))?.[0] || '';
}

function targetDeliveryAreas(data) {
  const addresses = deliveryAddresses(data);
  const areas = addresses.map(targetAreaFor);
  if (!addresses.length || areas.some((area) => !area)) return [];
  return [...new Set(areas)];
}

function tenderText(data) {
  return [
    data.title,
    data.description,
    data.classification?.description,
    ...(data.items || []).flatMap((item) => [item.description, item.classification?.description]),
    ...(data.documents || []).map((document) => document.title)
  ].filter(Boolean).join(' ').toLowerCase();
}

function dkCodes(data) {
  return [data.classification?.id, ...(data.items || []).map((item) => item.classification?.id)]
    .filter(Boolean)
    .map((code) => String(code));
}

function titleHasRelevantSignal(data) {
  const title = String(data.title || '').toLowerCase();
  return TITLE_RELEVANCE_TERMS.some((term) => title.includes(term));
}

function hasRelevantDkCode(data) {
  return dkCodes(data).some((code) => TARGET_DK_PREFIXES.some((prefix) => code.replace(/\D/g, '').startsWith(prefix)));
}

function detectMaterial(text) {
  return MATERIAL_RULES.find((rule) => rule.patterns.some((pattern) => text.includes(pattern)))?.material || '';
}

function isRelevant(data, text, material) {
  // Direct material evidence in an item/description has the highest priority.
  // Otherwise retain only a title signal or a relevant CPV class, never a
  // generic "repair" / "construction" word.
  return Boolean(material) || titleHasRelevantSignal(data) || hasRelevantDkCode(data);
}

function itemCharacteristics(data) {
  return (data.items || []).map((item) => item.description).filter(Boolean).join('; ').slice(0, 1000);
}

function itemVolume(item) {
  if (item.quantity === undefined || item.quantity === null) return '';
  return `${item.quantity} ${item.unit?.name || item.unit?.code || 'од.'}`;
}

function materialRequirements(data) {
  return (data.items || []).map((item, index) => {
    const text = [item.description, item.classification?.description].filter(Boolean).join(' ');
    const material = detectMaterial(text.toLowerCase());
    if (!material) return null;

    return {
      material,
      characteristics: text.slice(0, 1000),
      volume: itemVolume(item),
      evidence: `Позиція ${index + 1} у відкритих даних Prozorro: ${text}`.slice(0, 1200)
    };
  }).filter(Boolean);
}

function technicalDocuments(data) {
  return (data.documents || []).filter((document) => {
    const title = (document.title || '').toLowerCase();
    const format = (document.format || '').toLowerCase();
    return document.url && !format.includes('pkcs7') && !title.endsWith('.p7s');
  }).slice(0, 10).map((document) => ({
    title: document.title || 'Документ Prozorro',
    format: document.format || '',
    url: document.url,
    publishedAt: document.datePublished || ''
  }));
}

async function latestProzorro() {
  const feed = await fetch('https://public-api.prozorro.gov.ua/api/2.5/tenders?limit=80&descending=1', {
    headers: { Accept: 'application/json' }
  });

  if (!feed.ok) {
    throw new Error(`Prozorro відповів кодом ${feed.status}`);
  }

  const payload = await feed.json();
  const ids = (payload.data || []).map((item) => item.id).filter(Boolean);
  const records = await Promise.all(ids.map(async (id) => {
    const response = await fetch(`https://public-api.prozorro.gov.ua/api/2.5/tenders/${id}`, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) return null;

    const { data } = await response.json();
    const text = tenderText(data);
    const material = detectMaterial(text);
    if (!isRelevant(data, text, material)) return null;
    const deliveryAreas = targetDeliveryAreas(data);
    if (!deliveryAreas.length) return null;
    const requirements = materialRequirements(data);
    const primaryRequirement = requirements[0] || null;
    const documents = technicalDocuments(data);

    return {
      externalId: data.id,
      title: data.title || 'Без назви',
      buyer: data.procuringEntity?.name || 'Не вказано',
      region: deliveryAreas.join('; '),
      budget: data.value?.amount || '',
      currency: data.value?.currency || 'UAH',
      deadline: data.tenderPeriod?.endDate || '',
      url: `https://prozorro.gov.ua/tender/${data.tenderID || data.id}`,
      status: data.status || 'active.tendering',
      source: 'Prozorro',
      block: 'budget',
      material: primaryRequirement?.material || material,
      characteristics: primaryRequirement?.characteristics || itemCharacteristics(data),
      volume: primaryRequirement?.volume || '',
      winner: '',
      winnerContacts: '',
      evidence: `${primaryRequirement?.evidence || 'Потребує перевірки технічної документації: матеріал не знайдено серед відкритих позицій закупівлі.'} Код ДК 021:2015: ${dkCodes(data).join(', ') || 'не вказано'}`.slice(0, 1800),
      requirements,
      documents
    };
  }));

  return records.filter(Boolean).slice(0, 8);
}

module.exports = async (request, response) => {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    response.status(200).json(await latestProzorro());
  } catch (error) {
    response.status(502).json({ error: error.message || 'Не вдалося отримати дані Prozorro' });
  }
};
