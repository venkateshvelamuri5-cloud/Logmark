import { createClient } from 'redis';

export default async function handler(req, res) {
  const query = req.query || {};
  const encryptedProfileId = query.encryptedProfileId;

  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('Access-Control-Allow-Origin', '*');

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

    // 2. Fetch profile from Supabase to check status and load metadata
    let profileName = 'AI Assistant';
    let profileDesc = 'Personalized SLM Assistant';
    let profileIcon = '🤖';
    let isPaused = false;

    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      try {
        const supRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/slm_profiles?id=eq.${encodeURIComponent(profileId)}`, {
          headers: {
            'apikey': process.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
          }
        });
        if (supRes.ok) {
          const rows = await supRes.json();
          if (rows && rows.length > 0) {
            const p = rows[0];
            isPaused = p.status === 'paused';
            profileName = p.name || profileName;
            
            let meta = {};
            if (p.avatar) {
              if (typeof p.avatar === 'object') {
                meta = p.avatar;
              } else if (typeof p.avatar === 'string' && p.avatar.startsWith('{')) {
                try { meta = JSON.parse(p.avatar); } catch(e) {}
              }
            }
            profileDesc = meta.desc || p.desc || profileDesc;
            profileIcon = meta.icon || p.icon || profileIcon;
          }
        }
      } catch (err) {
        console.warn('[Vercel Redirect] Supabase check failed:', err.message);
      }
    }

    if (isPaused) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <div style="font-family:sans-serif; text-align:center; padding:100px 20px; background:#f9f9f9; min-height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center; margin:0;">
          <div style="background:white; padding:40px; border-radius:12px; box-shadow:0 4px 15px rgba(0,0,0,0.05); max-width:450px; border:1px solid #eee;">
            <div style="font-size:48px; margin-bottom:16px;">⏸️</div>
            <h2 style="color:#2c3e50; font-size:20px; font-weight:700; margin-bottom:10px; font-family:'Segoe UI',system-ui,sans-serif;">Demo Temporarily Paused</h2>
            <p style="color:#7f8c8d; font-size:13px; line-height:1.6; margin-bottom:0;">This assistant's public demo is currently paused by the administrator. Please contact the team or check back later.</p>
          </div>
        </div>
      `);
      return;
    }

    let tunnelUrl = await client.get(`tunnel:${profileId}`);

    if (tunnelUrl) {
      // Verify if the tunnel is actually online in real-time using native Node.js http/https
      let isTunnelOnline = false;
      try {
        const urlParser = new URL(tunnelUrl);
        const protocol = urlParser.protocol === 'https:' ? require('https') : require('http');
        isTunnelOnline = await new Promise((resolve) => {
          const req = protocol.get(`${tunnelUrl}/llama-status`, { timeout: 1200 }, (pingRes) => {
            resolve(pingRes.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.on('timeout', () => {
            req.destroy();
            resolve(false);
          });
        });
      } catch (err) {
        console.log('[Vercel Redirect] Tunnel check error:', err?.message || err);
      }

      if (isTunnelOnline) {
        res.writeHead(302, { Location: `${tunnelUrl}/demo/${profileId}` });
        res.end();
        return;
      } else {
        // Tunnel is dead! Remove from Redis immediately so we fall back to cloud mode
        try {
          await client.del(`tunnel:${profileId}`);
        } catch (e) {}
      }
    }
      const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
      if (githubToken) {
        // Laptop is Offline but Cloud Mode is Configured: Serve the cloud-hosted Chat Client
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${profileName} | Logmark Cloud Assistant</title>
            <style>
              :root {
                --bg: #0b0f19;
                --surface: #151c2c;
                --border: rgba(255, 255, 255, 0.08);
                --accent: #10b981;
                --text: #f3f4f6;
                --text-muted: #9ca3af;
              }
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                background-color: var(--bg);
                color: var(--text);
                display: flex;
                flex-direction: column;
                height: 100vh;
                overflow: hidden;
              }
              .header {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 16px;
                background-color: var(--surface);
                border-bottom: 1px solid var(--border);
              }
              .header-icon { font-size: 28px; }
              .header-title { font-size: 15px; font-weight: 700; }
              .header-desc { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
              .chat-container {
                flex: 1;
                padding: 16px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 14px;
              }
              .message {
                max-width: 80%;
                padding: 12px 16px;
                border-radius: 12px;
                font-size: 13px;
                line-height: 1.5;
              }
              .message.user {
                align-self: flex-end;
                background-color: var(--accent);
                color: white;
                border-bottom-right-radius: 2px;
              }
              .message.assistant {
                align-self: flex-start;
                background-color: var(--surface);
                border: 1px solid var(--border);
                border-bottom-left-radius: 2px;
              }
              .input-area {
                padding: 16px;
                background-color: var(--surface);
                border-top: 1px solid var(--border);
                display: flex;
                gap: 8px;
              }
              .input-box {
                flex: 1;
                background-color: var(--bg);
                border: 1px solid var(--border);
                border-radius: 8px;
                padding: 12px 14px;
                color: var(--text);
                font-size: 13px;
                outline: none;
              }
              .input-box:focus { border-color: var(--accent); }
              .send-btn {
                background-color: var(--accent);
                color: white;
                border: none;
                border-radius: 8px;
                padding: 0 18px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
              }
              .typing-indicator {
                align-self: flex-start;
                background-color: var(--surface);
                padding: 12px 16px;
                border-radius: 12px;
                border: 1px solid var(--border);
                font-size: 12px;
                color: var(--text-muted);
                display: none;
              }
            </style>
          </head>
          <body>
            <div class="header">
              <div class="header-icon">${profileIcon}</div>
              <div>
                <div class="header-title">${profileName}</div>
                <div class="header-desc">${profileDesc}</div>
              </div>
              <div style="margin-left:auto; display:flex; align-items:center; gap:6px; background:rgba(16,185,129,0.1); padding:4px 8px; border-radius:12px; font-size:10px; color:var(--accent); font-weight:700;">
                <span style="display:inline-block; width:6px; height:6px; background:var(--accent); border-radius:50%;"></span> Cloud
              </div>
            </div>
            <div class="chat-container" id="chat">
              <div class="message assistant">Hello! I am ${profileName}, powered by Logmark Cloud. Ask me anything about my knowledge base.</div>
            </div>
            <div class="typing-indicator" id="indicator">Assistant is thinking...</div>
            <div class="input-area">
              <input type="text" class="input-box" id="userInput" placeholder="Ask a question..." onkeydown="if(event.key==='Enter') sendMessage()">
              <button class="send-btn" onclick="sendMessage()">Send</button>
            </div>
            <script>
              const chatHistory = [];
              const profileId = "${profileId}";
              
              async function sendMessage() {
                const input = document.getElementById('userInput');
                const text = input.value.trim();
                if (!text) return;
                input.value = '';

                appendMessage(text, 'user');
                chatHistory.push({ role: 'user', content: text });

                const indicator = document.getElementById('indicator');
                indicator.style.display = 'block';

                try {
                  const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profileId, messages: chatHistory })
                  });
                  
                  if (!res.ok) {
                    const errData = await res.json();
                    throw new Error(errData.error || 'Server error');
                  }

                  const data = await res.json();
                  const reply = data.choices[0]?.message?.content || 'I could not generate an answer.';
                  
                  appendMessage(reply, 'assistant');
                  chatHistory.push({ role: 'assistant', content: reply });
                } catch(err) {
                  appendMessage("❌ Error: " + err.message, 'assistant');
                } finally {
                  indicator.style.display = 'none';
                }
              }

              function appendMessage(text, sender) {
                const chat = document.getElementById('chat');
                const div = document.createElement('div');
                div.className = 'message ' + sender;
                div.textContent = text;
                chat.appendChild(div);
                chat.scrollTop = chat.scrollHeight;
              }
            </script>
          </body>
          </html>
        `);
      } else {
        // Laptop is Offline and Cloud Mode is NOT configured yet: Serve the standard Offline page
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <div style="font-family:sans-serif; text-align:center; padding:100px 20px; background:#f9f9f9; min-height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center; margin:0;">
            <div style="background:white; padding:45px; border-radius:12px; box-shadow:0 4px 15px rgba(0,0,0,0.05); max-width:450px; border:1px solid #eee;">
              <div style="font-size:48px; margin-bottom:16px;">🔌</div>
              <h2 style="color:#2c3e50; font-size:20px; font-weight:700; margin-bottom:10px; font-family:'Segoe UI',system-ui,sans-serif;">Assistant Offline</h2>
              <p style="color:#7f8c8d; font-size:13px; line-height:1.6; margin-bottom:0;">This assistant is currently offline. Please check back later or contact the administrator.</p>
            </div>
          </div>
        `);
      }
  } catch (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <div style="font-family:sans-serif; text-align:center; padding:100px 20px; background:#f9f9f9; min-height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center; margin:0;">
        <div style="background:white; padding:45px; border-radius:12px; box-shadow:0 4px 15px rgba(0,0,0,0.05); max-width:450px; border:1px solid #eee;">
          <div style="font-size:48px; margin-bottom:16px;">🔌</div>
          <h2 style="color:#2c3e50; font-size:20px; font-weight:700; margin-bottom:10px; font-family:'Segoe UI',system-ui,sans-serif;">Assistant Offline</h2>
          <p style="color:#7f8c8d; font-size:13px; line-height:1.6; margin-bottom:0;">This assistant is currently offline. Please check back later or contact the administrator.</p>
        </div>
      </div>
    `);
  } finally {
    try { await client.quit(); } catch(e) {}
  }
}
