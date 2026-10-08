/**
 * Vercel serverless endpoint for the public Prozorro tender feed.
 * It deliberately contains no credentials: Prozorro's public API is queried
 * only when a client requests /api/prozorro.
 */
const CONSTRUCTION_KEYWORDS = [
  'нове будівництво', 'будівництво', 'реконструкц', 'капітальн',
  'поточний ремонт', 'ремонт покрів', 'благоустр', 'укритт',
  'фундамент', 'покрівл', 'дорожн', 'тротуар', 'дренаж'
];

const MATERIAL_RULES = [
  { material: 'геотекстиль', patterns: ['геотекстил', 'геотканин'] },
  { material: 'ПВХ-мембрана', patterns: ['пвх-мембран', 'pvc мембран'] },
  { material: 'дренажна мембрана', patterns: ['дренажн'] },
  { material: 'гідроізоляційна мембрана', patterns: ['гідроізоляц', 'гідромембран'] },
  { material: 'покрівельна мембрана', patterns: ['покрівельн мембран', 'рулонн покрів'] }
];

function tenderText(data) {
  return [
    data.title,
    data.description,
    data.classification?.description,
    ...(data.items || []).flatMap((item) => [item.description, item.classification?.description])
  ].filter(Boolean).join(' ').toLowerCase();
}

function detectMaterial(text) {
  return MATERIAL_RULES.find((rule) => rule.patterns.some((pattern) => text.includes(pattern)))?.material || '';
}

function isRelevant(text, material) {
  return Boolean(material) || CONSTRUCTION_KEYWORDS.some((keyword) => text.includes(keyword));
}

function itemCharacteristics(data) {
  return (data.items || []).map((item) => item.description).filter(Boolean).join('; ').slice(0, 1000);
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
    if (!isRelevant(text, material)) return null;

    return {
      externalId: data.id,
      title: data.title || 'Без назви',
      buyer: data.procuringEntity?.name || 'Не вказано',
      region: data.deliveryAddress?.region || data.items?.[0]?.deliveryAddress?.region || 'Не вказано',
      budget: data.value?.amount || '',
      currency: data.value?.currency || 'UAH',
      deadline: data.tenderPeriod?.endDate || '',
      url: `https://prozorro.gov.ua/tender/${data.tenderID || data.id}`,
      status: data.status || 'active.tendering',
      source: 'Prozorro',
      block: 'budget',
      material,
      characteristics: itemCharacteristics(data),
      volume: '',
      winner: '',
      winnerContacts: '',
      evidence: 'Дані з публічного API Prozorro'
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
