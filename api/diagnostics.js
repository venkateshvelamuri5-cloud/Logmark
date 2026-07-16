import { createClient } from '@vercel/kv';

export default async function handler(req, res) {
  const envKeys = Object.keys(process.env);
  const redisKeysDetected = envKeys.filter(k => k.includes('REDIS') || k.includes('KV') || k.includes('UPSTASH'));

  // Mask tokens for safety
  const maskedEnv = {};
  redisKeysDetected.forEach(key => {
    const val = process.env[key];
    maskedEnv[key] = val ? `${val.substring(0, 10)}... (length: ${val.length})` : 'undefined';
  });

  const redisUrl = process.env.KV_REST_API_URL || 
                   process.env.KV_URL || 
                   process.env.KV_UPSTASH_REDIS_REST_URL || 
                   process.env.UPSTASH_REDIS_REST_URL;

  const redisToken = process.env.KV_REST_API_TOKEN || 
                      process.env.KV_TOKEN || 
                      process.env.KV_UPSTASH_REDIS_REST_TOKEN || 
                      process.env.UPSTASH_REDIS_REST_TOKEN;

  let dbConnectionTest = 'Not Attempted';
  let dbConnectionError = null;

  if (redisUrl && redisToken) {
    try {
      const kv = createClient({
        url: redisUrl,
        token: redisToken,
      });
      await kv.set('diagnostics_test_key', 'ok', { ex: 5 });
      const testVal = await kv.get('diagnostics_test_key');
      dbConnectionTest = testVal === 'ok' ? '🟢 Success (Read/Write OK)' : '🔴 Failed value check';
    } catch (e) {
      dbConnectionTest = '🔴 Failed';
      dbConnectionError = e.message;
    }
  } else {
    dbConnectionTest = '🔴 Skipped (Missing Credentials)';
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: true,
    message: "Logmark Vercel Diagnostics Status",
    databaseConnectionTest: dbConnectionTest,
    databaseErrorTrace: dbConnectionError,
    detectedRedisEnvVariables: maskedEnv,
    activeUrlUsed: redisUrl ? `${redisUrl.substring(0, 15)}...` : 'none',
  }, null, 2));
}
