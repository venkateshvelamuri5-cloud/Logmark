import { createClient } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { profileId, tunnelUrl } = req.body;

  // Self-healing environment variable detection
  const redisUrl = process.env.KV_REST_API_URL || 
                   process.env.KV_URL || 
                   process.env.KV_UPSTASH_REDIS_REST_URL || 
                   process.env.UPSTASH_REDIS_REST_URL;

  const redisToken = process.env.KV_REST_API_TOKEN || 
                      process.env.KV_TOKEN || 
                      process.env.KV_UPSTASH_REDIS_REST_TOKEN || 
                      process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: 'Database credentials not configured in Vercel environment variables.' });
  }

  try {
    const kv = createClient({
      url: redisUrl,
      token: redisToken,
    });

    // Store mapping in Redis (expires in 2 hours)
    await kv.set(`tunnel:${profileId}`, tunnelUrl, { ex: 7200 });

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
