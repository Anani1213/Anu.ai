// api/chat.js - Fixed CORS & Model Proxy for Vercel
export default async function handler(req, res) {
  // 1. Explicit CORS Headers Setup (GitHub Pages ጥሪ እንዲቀበል)
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  // 2. Handle CORS Preflight Options Request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, model } = req.body || {};
    const apiKey = (process.env.GROQ_API_KEY || '').trim();

    if (!apiKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY is missing in Vercel Environment Variables.' });
    }

    // 3. Custom UI Engine IDs -> Active Groq Models Map
    const GROQ_MODEL_MAP = {
      'openai/gpt-oss-120b': 'llama-3.1-8b-instant',
      'openai/gpt-oss-20b': 'llama-3.1-8b-instant',
      'qwen/qwen3-32b': 'llama-3.1-8b-instant',
      'meta-llama/llama-4-scout-17b-16e-instruct': 'llama-3.1-8b-instant'
    };

    const targetModel = GROQ_MODEL_MAP[model] || 'llama-3.1-8b-instant';

    let cleanedMessages = Array.isArray(messages)
      ? messages.filter(m => m && m.role && m.content).map(m => ({ role: String(m.role), content: String(m.content) }))
      : [{ role: 'user', content: 'Hi' }];

    // 4. Fetch to Groq API
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: targetModel,
        messages: cleanedMessages,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Groq Request Failed' });
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Backend Server Error: ' + error.message });
  }
}
