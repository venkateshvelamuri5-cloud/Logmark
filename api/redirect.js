import { createClient } from 'redis';

export default async function handler(req, res) {
  const query = req.query || {};
  const encryptedProfileId = query.encryptedProfileId;

  if (!encryptedProfileId) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`
      <div style="font-family:sans-serif; text-align:center; padding:50px 20px;">
        <h2 style="color:#d9534f;">⚠️ Invalid Request</h2>
        <p style="color:#555;">No assistant profile ID was specified in the URL path.</p>
      </div>
    `);
    return;
  }

  const redisUrl = process.env.KV_REDIS_URL;

  if (!redisUrl) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`
      <div style="font-family:sans-serif; text-align:center; padding:50px 20px;">
        <h2 style="color:#d9534f;">⚙️ Database Configuration Missing</h2>
        <p style="color:#555;">The KV_REDIS_URL environment variable was not detected in Vercel.</p>
      </div>
    `);
    return;
  }

  // Connect using TCP Redis client
  const client = createClient({ url: redisUrl });
  
  try {
    await client.connect();

    // 1. Decode URL-safe Base64 hash back to raw Profile ID
    const base64 = encryptedProfileId.replace(/-/g, '+').replace(/_/g, '/');
    const profileId = Buffer.from(base64, 'base64').toString('utf8');

    // 2. Lookup the active tunnel URL
    const tunnelUrl = await client.get(`tunnel:${profileId}`);

    if (tunnelUrl) {
      // 3. Redirect to the active local tunnel demo page
      res.writeHead(302, { Location: `${tunnelUrl}/demo/${profileId}` });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <div style="font-family:sans-serif; text-align:center; padding:50px 20px;">
          <h2 style="color:#d9534f;">🔌 Assistant Offline</h2>
          <p style="color:#555;">The developer has stopped sharing this demo or closed the Logmark application.</p>
        </div>
      `);
    }
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  } finally {
    try { await client.quit(); } catch(e) {}
  }
}
