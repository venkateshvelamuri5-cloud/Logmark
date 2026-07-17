import { createClient } from 'redis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Token Verification Guard
  const authHeader = req.headers['authorization'];
  const expectedKey = process.env.LOGMARK_API_KEY || 'logmark_secure_session_token_2025';
  if (!authHeader || authHeader !== `Bearer ${expectedKey}`) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API credentials' });
  }

  const { profileId, tunnelUrl } = req.body;
  const redisUrl = process.env.KV_REDIS_URL;

  if (!redisUrl) {
    return res.status(500).json({ error: 'KV_REDIS_URL environment variable is missing on Vercel.' });
  }

  // Connect using TCP Redis client
  const client = createClient({ url: redisUrl });

  try {
    await client.connect();

    // Store mapping in Redis (expires in 2 hours = 7200 seconds)
    await client.set(`tunnel:${profileId}`, tunnelUrl, { EX: 7200 });

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    try { await client.quit(); } catch(e) {}
  }
}
