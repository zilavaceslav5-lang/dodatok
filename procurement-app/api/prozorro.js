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
  'покрів', 'дах', 'фасад', 'рулонн покрів', 'утеплен', 'теплоізоляц',
  'термоізоляц', 'пароізоляц', 'вітробар', 'гідробар', 'склосіт',
  'водостіч', 'водовідвед', 'поливо', 'зрошув', 'вентиляц', 'опалення',
  'інженерн мереж', 'трубопровод'
];

// CPV / ДК 021:2015 classes that are materially connected to the above work.
// A generic capital-repair code is intentionally not sufficient.
const TARGET_DK_PREFIXES = ['4523', '4526', '4532', '4533', '4545', '4511271'];

const MATERIAL_RULES = [
  { material: 'геотекстиль', patterns: ['геотекстил', 'геотканин'] },
  { material: 'ПВХ-мембрана', patterns: ['пвх-мембран', 'pvc мембран'] },
  { material: 'дренажна мембрана', allPatterns: ['дренажн', 'мембран'] },
  { material: 'гідро- і пароізоляція', patterns: ['гідроізоляц', 'гідромембран', 'пароізоляц', 'гідробар', 'вітробар', 'рубероїд', 'бітумн мастик'] },
  { material: 'теплоізоляція / мінеральна вата', patterns: ['мінеральн ват', 'мінераловат', 'базальтов', 'скловат', 'теплоізоляц', 'утеплювач', 'пінополістирол', 'екструдован'] },
  { material: 'фасадна склосітка', patterns: ['склосіт', 'армувальн сіт'] },
  { material: 'водостічна система', patterns: ['водостічн'] },
  { material: 'труби ПВХ / ПП / ПЕ', patterns: ['труба пвх', 'труби пвх', 'труба пп', 'труби пп', 'поліпропіленов', 'поліетиленов', 'труба пе', 'пе 100'] },
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

function buyerAddress(data) {
  const address = data.procuringEntity?.address;
  return address && (address.region || address.locality) ? [{ region: address.region || '', locality: address.locality || '' }] : [];
}

function targetAreaFor(address) {
  const location = normalizeLocation(`${address.region} ${address.locality}`);
  return TARGET_AREA_LABELS.find(([, terms]) => terms.some((term) => location.includes(term)))?.[0] || '';
}

function targetCoverageAreas(data) {
  // The supplied benchmark selects by the buyer's service region. Prefer the
  // buyer address; delivery locations are a fallback when it is unavailable.
  const addresses = buyerAddress(data).length ? buyerAddress(data) : deliveryAddresses(data);
  const areas = addresses.map(targetAreaFor);
  if (!addresses.length || areas.some((area) => !area)) return [];
  return [...new Set(areas)];
}

function tenderText(data) {
  return [
    data.title,
    data.description,
    data.classification?.description,
    ...(data.items || []).flatMap((item) => [item.description, item.classification?.description])
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
  return MATERIAL_RULES.find((rule) =>
    rule.patterns?.some((pattern) => text.includes(pattern)) ||
    rule.allPatterns?.every((pattern) => text.includes(pattern))
  )?.material || '';
}

function relevanceReason(data, material) {
  // A concrete material in an open item/description is strong evidence.
  if (material) return 'У відкритих даних виявлено конкретний матеріал для перевірки.';
  // A work code by itself (or a broad keyword by itself) causes too many false
  // positives. A potential opportunity requires both signals and must still be
  // confirmed in the technical assignment/resource statement.
  if (titleHasRelevantSignal(data) && hasRelevantDkCode(data)) {
    return 'Назва та код ДК вказують на потенційну потребу; технічне завдання потребує перевірки.';
  }
  return '';
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

async function tenderById(id, stats) {
  try {
    const response = await fetch(`https://public-api.prozorro.gov.ua/api/2.5/tenders/${id}`, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) return null;

    const { data } = await response.json();
    stats.scanned += 1;
    const coverageAreas = targetCoverageAreas(data);
    if (!coverageAreas.length) {
      stats.excludedOutsideCoverage += 1;
      return null;
    }
    stats.inCoverage += 1;
    const text = tenderText(data);
    const material = detectMaterial(text);
    const selectionReason = relevanceReason(data, material);
    if (!selectionReason) {
      stats.excludedNoEvidence += 1;
      return null;
    }
    const selectionType = material ? 'confirmed' : 'potential';
    stats[selectionType === 'confirmed' ? 'materialEvidence' : 'potential'] += 1;
    const requirements = materialRequirements(data);
    const primaryRequirement = requirements[0] || null;
    const documents = technicalDocuments(data);

    return {
      externalId: data.id,
      title: data.title || 'Без назви',
      buyer: data.procuringEntity?.name || 'Не вказано',
      region: coverageAreas.join('; '),
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
      selectionType,
      evidence: `${primaryRequirement?.evidence || selectionReason} Код ДК 021:2015: ${dkCodes(data).join(', ') || 'не вказано'}`.slice(0, 1800),
      requirements,
      documents
    };
  } catch {
    return null;
  }
}

async function latestProzorro() {
  let pageUrl = 'https://public-api.prozorro.gov.ua/api/2.5/tenders?limit=80&descending=1';
  const records = [];
  const stats = {
    pages: 0,
    scanned: 0,
    inCoverage: 0,
    materialEvidence: 0,
    potential: 0,
    excludedOutsideCoverage: 0,
    excludedNoEvidence: 0
  };

  // A browser action must complete within Vercel's short serverless timeout.
  // Scan one complete, recent feed page per click; keeping the manager's
  // existing queue means consecutive refreshes never erase earlier results.
  for (let page = 0; page < 1 && pageUrl && records.length < 8; page += 1) {
    const feed = await fetch(pageUrl, { headers: { Accept: 'application/json' } });
    if (!feed.ok) throw new Error(`Prozorro відповів кодом ${feed.status}`);
    const payload = await feed.json();
    stats.pages += 1;
    const ids = (payload.data || []).map((item) => item.id).filter(Boolean);

    // Avoid opening dozens of connections to the public API at once.
    for (let start = 0; start < ids.length && records.length < 8; start += 20) {
      const batch = await Promise.all(ids.slice(start, start + 20).map((id) => tenderById(id, stats)));
      records.push(...batch.filter(Boolean));
    }

    const next = payload.next_page?.uri || payload.next_page?.path;
    pageUrl = next ? new URL(next, 'https://public-api.prozorro.gov.ua').toString() : '';
  }

  return {
    version: 'benchmark-v2',
    records: records.slice(0, 8),
    stats
  };
}

module.exports = async (request, response) => {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    response.status(200).json(await latestProzorro());
  } catch (error) {
    response.status(502).json({ error: error.message || 'Не вдалося отримати дані Prozorro' });
  }
};
