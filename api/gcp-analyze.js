import { createClient } from 'redis';

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
  const crypto = require('crypto');
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

    // 3. Assemble Prompt Context
    const fullPrompt = `${instructions || ''}\n\n[DOCUMENT CONTENT]\n${text}`;
    const cleanPrompt = sanitizePII(fullPrompt);

    // 4. Generate GCP Access Token
    const accessToken = await generateGcpToken(gcpKey);
    const gcpProjectId = JSON.parse(gcpKey).project_id;

    // 5. Submit generateContent Request to Vertex AI (Gemini 1.5 Flash)
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
    const generatedText = result.candidates?.[0]?.content?.parts?.[0]?.text || '';

    res.status(200).json({ success: true, text: generatedText });

  } catch(err) {
    console.error('[GCP Analyze API Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
}
