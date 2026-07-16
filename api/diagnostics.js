import { createClient } from 'redis';

export default async function handler(req, res) {
  const envKeys = Object.keys(process.env);
  const redisKeysDetected = envKeys.filter(k => k.includes('REDIS') || k.includes('KV') || k.includes('UPSTASH'));

  // Mask sensitive values
  const maskedEnv = {};
  redisKeysDetected.forEach(key => {
    const val = process.env[key];
    maskedEnv[key] = val ? `${val.substring(0, 10)}... (length: ${val.length})` : 'undefined';
  });

  const redisUrl = process.env.KV_REDIS_URL;
  let dbConnectionTest = 'Not Attempted';
  let dbConnectionError = null;

  if (redisUrl) {
    const client = createClient({ url: redisUrl });
    try {
      await client.connect();
      await client.set('diagnostics_test_key', 'ok', { EX: 5 });
      const testVal = await client.get('diagnostics_test_key');
      dbConnectionTest = testVal === 'ok' ? '🟢 Success (TCP Read/Write OK)' : '🔴 Failed value check';
      await client.quit();
    } catch (e) {
      dbConnectionTest = '🔴 Failed';
      dbConnectionError = e.message;
    }
  } else {
    dbConnectionTest = '🔴 Skipped (Missing KV_REDIS_URL)';
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    success: true,
    message: "Logmark Vercel Diagnostics Status (TCP Mode)",
    databaseConnectionTest: dbConnectionTest,
    databaseErrorTrace: dbConnectionError,
    detectedRedisEnvVariables: maskedEnv,
    activeUrlUsed: redisUrl ? `${redisUrl.substring(0, 15)}...` : 'none',
  }, null, 2));
}
