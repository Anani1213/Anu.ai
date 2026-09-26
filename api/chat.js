// api/chat.js - Universal Multi-Provider Proxy (Supports OpenRouter & Groq)
export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, model } = req.body || {};
    const apiKey = (process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();

    if (!apiKey) {
      return res.status(500).json({ error: 'API Key is missing in Vercel Environment Variables.' });
    }

    // Payload Cleanup
    let cleanedMessages = Array.isArray(messages)
      ? messages.filter(m => m && m.role && m.content).map(m => ({ role: String(m.role), content: String(m.content) }))
      : [{ role: 'user', content: 'Hi' }];

    // Detect Provider Type based on API Key prefix
    const isOpenRouter = apiKey.startsWith('sk-or-');
    
    let targetEndpoint = isOpenRouter
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.groq.com/openai/v1/chat/completions';

    let targetModel = model || 'openai/gpt-oss-120b';

    // If using Groq API key, map OpenRouter models to active Groq equivalents
    if (!isOpenRouter) {
      const GROQ_MODEL_MAP = {
        'openai/gpt-oss-120b': 'llama-3.3-70b-versatile',
        'openai/gpt-oss-20b': 'llama-3.1-8b-instant',
        'qwen/qwen3-32b': 'qwen-2.5-coder-32b',
        'meta-llama/llama-4-scout-17b-16e-instruct': 'llama-3.1-8b-instant'
      };
      targetModel = GROQ_MODEL_MAP[model] || 'llama-3.3-70b-versatile';
    }

    const response = await fetch(targetEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(isOpenRouter ? { 'HTTP-Referer': 'https://anu-ai.vercel.app', 'X-Title': 'Anu AI' } : {})
      },
      body: JSON.stringify({
        model: targetModel,
        messages: cleanedMessages,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const errText = data.error?.message || JSON.stringify(data.error) || 'API Request Failed';
      return res.status(response.status).json({ error: errText });
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Proxy Server Error: ' + error.message });
  }
}
