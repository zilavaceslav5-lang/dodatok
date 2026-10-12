module.exports = async (request, response) => {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    response.status(503).json({ error: 'Supabase ще не налаштовано' });
    return;
  }

  response.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  response.status(200).json({ url, anonKey });
};
