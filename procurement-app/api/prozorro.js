/**
 * Vercel serverless endpoint for the public Prozorro tender feed.
 * It deliberately contains no credentials: Prozorro's public API is queried
 * only when a client requests /api/prozorro.
 */
// Stage one deliberately finds a broad, reviewable queue of construction
// works. Stage two reads the technical assignment / bills and confirms only
// the opportunities containing Euroizol-relevant materials.
const STAGE_ONE_WORK_TERMS = [
  'нове будівництв', 'реконструкц', 'капітальн ремонт',
  'укрит', 'дах', 'покрів', 'фундамент', 'підвал',
  'дорог', 'благоустр', 'лагун', 'озер', 'ставк', 'водойм'
];
const BUILDING_TERMS = ['будівл', 'будинок', 'приміщенн', 'корпус', 'споруд'];
const NON_EXECUTION_TERMS = [
  'технічн нагляд', 'авторськ нагляд', 'обстеженн', 'ліфт'
];
const WINNER_RECOGNITION_WINDOW_DAYS = 30;
const WINNER_RECOGNITION_WINDOW_MS = WINNER_RECOGNITION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

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

function detectMaterial(text) {
  return MATERIAL_RULES.find((rule) =>
    rule.patterns?.some((pattern) => text.includes(pattern)) ||
    rule.allPatterns?.every((pattern) => text.includes(pattern))
  )?.material || '';
}

function stageOneAssessment(data) {
  const text = tenderText(data);
  const codes = dkCodes(data).map((code) => code.replace(/\D/g, ''));
  // A word such as “поліетилен” can describe a rubbish bag or medical item.
  // It is never sufficient on its own: stage one is limited to construction
  // works (CPV 45) or design work for such objects (CPV 712), then stage two
  // confirms materials from tender documents.
  if (!codes.some((code) => code.startsWith('45') || code.startsWith('712'))) return null;
  if (NON_EXECUTION_TERMS.some((term) => text.includes(term))) return null;
  const isCurrentBuildingRepair = text.includes('поточн ремонт') && BUILDING_TERMS.some((term) => text.includes(term));
  const workTerm = STAGE_ONE_WORK_TERMS.find((term) => text.includes(term));
  if (workTerm || isCurrentBuildingRepair) {
    const source = isCurrentBuildingRepair ? 'поточний ремонт будівлі або споруди' : `вид робіт: ${workTerm}`;
    return {
      selectionType: 'potential',
      reason: `Перший етап відбору — ${source}. Потрібен аналіз технічного завдання, відомості обсягів робіт або відомості ресурсів.`
    };
  }

  return null;
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

function winnerRecognition(data, now = Date.now()) {
  const activeAwards = (data.awards || [])
    .filter((award) => award?.status === 'active')
    .sort((left, right) => Date.parse(right.date || right.dateModified || 0) - Date.parse(left.date || left.dateModified || 0));
  const award = activeAwards[0];
  if (!award) return { hasWinner: false, isRecent: false, winner: '', awardedAt: '' };

  const awardedAt = award.date || award.dateModified || '';
  const timestamp = Date.parse(awardedAt);
  const age = Number.isFinite(timestamp) ? now - timestamp : Number.POSITIVE_INFINITY;
  const winner = (award.suppliers || []).map((supplier) => supplier.name).filter(Boolean).join('; ');
  return {
    hasWinner: true,
    isRecent: age >= 0 && age <= WINNER_RECOGNITION_WINDOW_MS,
    winner,
    awardedAt
  };
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
    const recognition = winnerRecognition(data);
    const finishedStatuses = new Set(['complete', 'unsuccessful', 'cancelled']);
    // Active procedures may be worked on now. A finished procedure is shown
    // only when an active award was made during the agreed 30-day window.
    if (finishedStatuses.has(data.status) && !recognition.isRecent) {
      stats.excludedOldWinner += 1;
      return null;
    }
    const requirements = materialRequirements(data);
    const primaryRequirement = requirements[0] || null;
    const assessment = stageOneAssessment(data);
    if (!assessment) {
      stats.excludedNoEvidence += 1;
      return null;
    }
    if (recognition.isRecent) stats.recentWinners += 1;
    const selectionType = assessment.selectionType;
    // Public item descriptions are a signal for document analysis, not proof
    // of a Euroizol match. Confirmation is produced only by stage two.
    stats.potential += 1;
    const documents = technicalDocuments(data);
    const observedMaterial = detectMaterial(tenderText(data));

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
      material: primaryRequirement?.material || observedMaterial,
      characteristics: primaryRequirement?.characteristics || itemCharacteristics(data),
      volume: primaryRequirement?.volume || '',
      winner: recognition.winner,
      winnerContacts: '',
      winnerRecognizedAt: recognition.awardedAt,
      selectionType,
      documentConfidence: selectionType === 'potential' ? 'Потрібно перевірити' : null,
      evidence: `${primaryRequirement?.evidence || assessment.reason} Код ДК 021:2015: ${dkCodes(data).join(', ') || 'не вказано'}`.slice(0, 1800),
      requirements,
      documents
    };
  } catch {
    return null;
  }
}

async function latestProzorro(offset = '') {
  const feedUrl = new URL('https://public-api.prozorro.gov.ua/api/2.5/tenders');
  feedUrl.searchParams.set('limit', '80');
  feedUrl.searchParams.set('descending', '1');
  if (offset) feedUrl.searchParams.set('offset', offset);
  let pageUrl = feedUrl.toString();
  const records = [];
  const stats = {
    pages: 0,
    scanned: 0,
    inCoverage: 0,
    materialEvidence: 0,
    potential: 0,
    recentWinners: 0,
    excludedOutsideCoverage: 0,
    excludedNoEvidence: 0,
    excludedOldWinner: 0
  };
  let nextOffset = '';
  let oldestModified = '';

  // A browser action must complete within Vercel's short serverless timeout.
  // Scan one complete, recent feed page per click; keeping the manager's
  // existing queue means consecutive refreshes never erase earlier results.
  for (let page = 0; page < 1 && pageUrl && records.length < 8; page += 1) {
    const feed = await fetch(pageUrl, { headers: { Accept: 'application/json' } });
    if (!feed.ok) throw new Error(`Prozorro відповів кодом ${feed.status}`);
    const payload = await feed.json();
    stats.pages += 1;
    const modifiedDates = (payload.data || [])
      .map((item) => item.dateModified || item.public_modified)
      .filter(Boolean)
      .map((value) => typeof value === 'number' ? value * 1000 : Date.parse(value))
      .filter(Number.isFinite);
    if (modifiedDates.length) oldestModified = new Date(Math.min(...modifiedDates)).toISOString();
    const ids = (payload.data || []).map((item) => item.id).filter(Boolean);

    // Avoid opening dozens of connections to the public API at once.
    for (let start = 0; start < ids.length && records.length < 8; start += 20) {
      const batch = await Promise.all(ids.slice(start, start + 20).map((id) => tenderById(id, stats)));
      records.push(...batch.filter(Boolean));
    }

    nextOffset = String(payload.next_page?.offset || '');
    const next = payload.next_page?.uri || payload.next_page?.path;
    pageUrl = next ? new URL(next, 'https://public-api.prozorro.gov.ua').toString() : '';
  }

  return {
    version: 'two-stage-v1',
    records: records.slice(0, 8),
    stats,
    nextOffset,
    oldestModified
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
    response.status(200).json(await latestProzorro(String(request.query?.offset || '')));
  } catch (error) {
    response.status(502).json({ error: error.message || 'Не вдалося отримати дані Prozorro' });
  }
};
