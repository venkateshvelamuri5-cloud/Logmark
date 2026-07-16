import { createClient } from '@vercel/kv';

export default async function handler(req, res) {
  const { encryptedProfileId } = req.query;

  try {
    // 1. Decode URL-safe Base64 hash back to raw Profile ID
    const base64 = encryptedProfileId.replace(/-/g, '+').replace(/_/g, '/');
    const profileId = Buffer.from(base64, 'base64').toString('utf8');

    // 2. Connect to Vercel KV (Redis)
    const kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    // 3. Lookup the active tunnel URL mapped to the profileId
    const tunnelUrl = await kv.get(`tunnel:${profileId}`);

    if (tunnelUrl) {
      // 4. Redirect to the active local tunnel demo page
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
    res.status(500).json({ error: error.message });
  }
}
