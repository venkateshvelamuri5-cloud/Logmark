function sanitizePII(val) {
  if (typeof val !== 'string') return val;
  return val
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]')
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, '[REDACTED_CARD]')
    .replace(/\+?\d{1,4}?[-.\s]?\(?\d{1,3}?\)?[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g, '[REDACTED_PHONE]');
}

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { profileId, messages } = req.body || {};

  if (!profileId || !messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'Missing profileId or messages' });
    return;
  }

  const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!githubToken) {
    res.status(500).json({ error: 'Cloud LLM Credentials (GITHUB_TOKEN) missing on server.' });
    return;
  }

  if (!supabaseUrl || !supabaseKey) {
    res.status(500).json({ error: 'Supabase credentials missing on server.' });
    return;
  }

  try {
    // 1. Fetch profile and chunks from Supabase
    const supRes = await fetch(`${supabaseUrl}/rest/v1/slm_profiles?id=eq.${encodeURIComponent(profileId)}`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!supRes.ok) {
      throw new Error('Failed to retrieve assistant profile.');
    }

    const rows = await supRes.json();
    if (!rows || rows.length === 0) {
      res.status(404).json({ error: 'Assistant profile not found.' });
      return;
    }

    const p = rows[0];
    let meta = {};
    if (p.avatar && p.avatar.startsWith('{')) {
      try { meta = JSON.parse(p.avatar); } catch(e) {}
    }

    const systemPrompt = p.system_prompt || 'You are a helpful assistant.';
    const kbChunks = meta.kbChunks || [];

    // 2. Perform RAG keyword ranking on the user's latest query
    const userMessage = messages[messages.length - 1]?.content || '';
    let promptWithContext = userMessage;

    if (kbChunks.length > 0 && userMessage) {
      const keywords = userMessage.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2);

      const ranked = kbChunks.map(c => {
        let score = 0;
        const text = (c.text || '').toLowerCase();
        keywords.forEach(kw => {
          if (text.includes(kw)) score += 1;
        });
        return { ...c, score };
      })
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3); // top 3 chunks

      if (ranked.length > 0) {
        const contextText = ranked.map((c, i) => `[Source ${i+1}: ${c.src || 'doc'}]\n${c.text}`).join('\n\n');
        promptWithContext = `Use the following RAG knowledge base context to answer the user query:\n` +
          `=================================\n` +
          `${contextText}\n` +
          `=================================\n\n` +
          `User Query: ${userMessage}`;
      }
    }

    // Sanitize Prompt PII before sending to Cloud Inference
    const cleanPrompt = typeof sanitizePII === 'function' ? sanitizePII(promptWithContext) : promptWithContext;

    // 3. Construct chat messages array
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(0, -1),
      { role: 'user', content: cleanPrompt }
    ];

    // 4. Send inference request to GitHub Models Llama-3.2-3B
    const model = 'meta-llama-3.2-3b-instruct'; // free fast SLM
    const ghRes = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${githubToken}`
      },
      body: JSON.stringify({
        messages: apiMessages,
        model: model,
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    if (!ghRes.ok) {
      const errTxt = await ghRes.text();
      throw new Error(`GitHub Models Inference API Error: ${errTxt}`);
    }

    const data = await ghRes.json();
    res.status(200).json(data);

  } catch(err) {
    console.error('[Cloud Chat API error]:', err.message);
    res.status(500).json({ error: err.message });
  }
}
