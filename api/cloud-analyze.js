import { createClient } from 'redis';
import crypto from 'crypto';

// Simple PII Redaction
function sanitizePII(val) {
  if (typeof val !== 'string') return val;
  return val
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]')
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, '[REDACTED_CARD]')
    .replace(/\+?\d{1,4}?[-.\s]?\(?\d{1,3}?\)?[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g, '[REDACTED_PHONE]');
}

// Service Account JWT Signer using Web Crypto API
async function generateGcpToken(serviceAccountKeyJson) {
  const keys = JSON.parse(serviceAccountKeyJson);
  const claim = {
    iss: keys.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000)
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const payload = encode(header) + '.' + encode(claim);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(payload);
  const signature = sign.sign(keys.private_key, 'base64url');
  const jwt = payload + '.' + signature;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) {
    throw new Error('Failed to retrieve OAuth token from Google.');
  }
  const data = await res.json();
  return data.access_token;
}

export default async function handler(req, res) {
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

  const { userEmail, profileId, text, instructions } = req.body || {};

  if (!userEmail || !profileId || !text) {
    res.status(400).json({ error: 'Missing userEmail, profileId, or text' });
    return;
  }

  const cleanEmail = userEmail.toLowerCase().trim();

  // Load backend secrets
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const gcpKey = process.env.GCP_SERVICE_ACCOUNT_KEY;
  const gcpRegion = process.env.GCP_REGION || 'us-central1';

  if (!supabaseUrl || !supabaseKey) {
    res.status(500).json({ error: 'Supabase configurations are missing on server.' });
    return;
  }
  if (!gcpKey) {
    res.status(500).json({ error: 'GCP Service Account credentials (GCP_SERVICE_ACCOUNT_KEY) missing on server.' });
    return;
  }

  try {
    // 1. Authorize User Access Check (Super Admin override or Cloud Toggle verification)
    const SUPER_ADMINS = ['admin@slmforge.com', 'admin@logmark.com']; // Standard Super Admin fallbacks
    let isAuthorized = SUPER_ADMINS.includes(cleanEmail);

    if (!isAuthorized) {
      const licRes = await fetch(`${supabaseUrl}/rest/v1/licenses?email=eq.${encodeURIComponent(cleanEmail)}`, {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      });
      if (licRes.ok) {
        const rows = await licRes.json();
        if (rows && rows.length > 0) {
          const l = rows[0];
          const notes = l.notes || '';
          if (notes.startsWith('[gcp_access:true]')) {
            isAuthorized = true;
          }
        }
      }
    }

    if (!isAuthorized) {
      res.status(403).json({ error: 'Unauthorized: You do not have Logmark Cloud permission. Please contact your administrator.' });
      return;
    }

    // 2. Load Active Profile System Prompt from Supabase
    const profRes = await fetch(`${supabaseUrl}/rest/v1/slm_profiles?id=eq.${encodeURIComponent(profileId)}`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (!profRes.ok) {
      throw new Error('Failed to retrieve assistant profile configuration.');
    }

    const profiles = await profRes.json();
    if (!profiles || profiles.length === 0) {
      res.status(404).json({ error: 'Assistant profile not found.' });
      return;
    }

    const p = profiles[0];
    const systemPrompt = p.system_prompt || 'You are a helpful assistant.';

    // 3. Retrieve KB Chunks for RAG context matching
    let promptWithContext = `${instructions || ''}\n\n[DOCUMENT CONTENT]\n${text}`;
    
    try {
      const kbRes = await fetch(`${supabaseUrl}/rest/v1/kb_chunks?profile_id=eq.${encodeURIComponent(profileId)}`, {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      });
      
      if (kbRes.ok) {
        const kbChunks = await kbRes.json();
        if (kbChunks && kbChunks.length > 0) {
          const queryText = (instructions || '') + ' ' + (text || '');
          const cleanText = str => str.toLowerCase().replace(/[^a-z0-9\s]/g, '');
          const queryTokens = cleanText(queryText).split(/\s+/).filter(w => w.length > 2);
          const queryTokenSet = new Set(queryTokens);
          
          const ranked = kbChunks.map(c => {
            const chunkTokens = cleanText(c.text || '').split(/\s+/).filter(w => w.length > 2);
            let score = 0;
            chunkTokens.forEach(t => {
              if (queryTokenSet.has(t)) score += 1;
            });
            return { chunk: c, score };
          })
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map(x => x.chunk);
          
          if (ranked.length > 0) {
            const contextText = ranked.map((c, i) => `[Source ${i+1}: ${c.src || 'doc'}]\n${c.text}`).join('\n\n');
            promptWithContext = `Use the following RAG knowledge base context to process this document:\n` +
              `=================================\n` +
              `${contextText}\n` +
              `=================================\n\n` +
              `Task Instructions: ${instructions || ''}\n` +
              `[DOCUMENT CONTENT]\n` +
              `${text}`;
          } else {
            const fallbackChunks = kbChunks.slice(0, 3);
            const contextText = fallbackChunks.map((c, i) => `[General Guideline ${i+1}: ${c.src || 'doc'}]\n${c.text}`).join('\n\n');
            promptWithContext = `Use the following general guidelines to process this document:\n` +
              `=================================\n` +
              `${contextText}\n` +
              `=================================\n\n` +
              `Task Instructions: ${instructions || ''}\n` +
              `[DOCUMENT CONTENT]\n` +
              `${text}`;
          }
        }
      }
    } catch (e) {
      console.warn('[RAG] Failed to query kb_chunks during cloud-analyze:', e.message);
    }

    const cleanPrompt = sanitizePII(promptWithContext);

    // 4. Send inference request to Groq or fallback to Google Cloud Platform Vertex AI
    const groqApiKey = process.env.GROQ_API_KEY;
    let generatedText = '';

    if (groqApiKey) {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqApiKey}`
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: cleanPrompt }
          ],
          model: 'llama-3.1-8b-instant',
          temperature: 0.2,
          max_tokens: 4096
        })
      });

      if (!groqRes.ok) {
        const errTxt = await groqRes.text();
        throw new Error(`Groq Inference API Error: ${errTxt}`);
      }

      const groqData = await groqRes.json();
      generatedText = groqData.choices?.[0]?.message?.content || '';
    } else {
      // Generate GCP Access Token
      const accessToken = await generateGcpToken(gcpKey);
      const gcpProjectId = JSON.parse(gcpKey).project_id;

      // Submit generateContent Request to Vertex AI (Gemini 1.5 Flash)
      const vertexUrl = `https://${gcpRegion}-aiplatform.googleapis.com/v1/projects/${gcpProjectId}/locations/${gcpRegion}/publishers/google/models/gemini-1.5-flash:generateContent`;
      
      const vertexBody = {
        contents: [
          {
            role: 'user',
            parts: [{ text: cleanPrompt }]
          }
        ],
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048
        }
      };

      const vertexRes = await fetch(vertexUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(vertexBody)
      });

      if (!vertexRes.ok) {
        const errTxt = await vertexRes.text();
        throw new Error(`Vertex AI Prediction Error: ${errTxt}`);
      }

      const result = await vertexRes.json();
      generatedText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    res.status(200).json({ success: true, text: generatedText });

  } catch(err) {
    console.error('[GCP Analyze API Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
}
