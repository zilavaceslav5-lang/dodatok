/**
 * Vercel serverless endpoint for the public Prozorro tender feed.
 * It deliberately contains no credentials: Prozorro's public API is queried
 * only when a client requests /api/prozorro.
 */
async function latestProzorro() {
  const feed = await fetch('https://public-api.prozorro.gov.ua/api/2.5/tenders?limit=8', {
    headers: { Accept: 'application/json' }
  });

  if (!feed.ok) {
    throw new Error(`Prozorro відповів кодом ${feed.status}`);
  }

  const payload = await feed.json();
  const ids = (payload.data || []).map((item) => item.id).filter(Boolean).slice(0, 8);
  const records = await Promise.all(ids.map(async (id) => {
    const response = await fetch(`https://public-api.prozorro.gov.ua/api/2.5/tenders/${id}`, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) return null;

    const { data } = await response.json();
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
      material: '',
      characteristics: '',
      volume: '',
      winner: '',
      winnerContacts: '',
      evidence: 'Дані з публічного API Prozorro'
    };
  }));

  return records.filter(Boolean);
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
