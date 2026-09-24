// api/chat.js - Smart Model Mapping & Robust Error Handler
export default async function handler(req, res) {
  // 1. CORS Headers Setup
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  try {
    const { messages, model } = req.body || {};

    // Check if API key exists
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: { message: 'GROQ_API_KEY is missing in Vercel Environment Variables.' } });
    }

    // 2. MODEL MAPPER: Convert any custom model string to official active Groq models
    const MODEL_MAPPING = {
      'openai/gpt-oss-120b': 'llama-3.3-70b-versatile',
      'openai/gpt-oss-20b': 'llama-3.1-8b-instant',
      'qwen/qwen3-32b': 'qwen-2.5-coder-32b',
      'meta-llama/llama-4-scout-17b-16e-instruct': 'llama-3.1-8b-instant',
      'Anu Deep Reasoning v3.6': 'llama-3.3-70b-versatile',
      'Anu Fast Core v3.6': 'llama-3.1-8b-instant',
      'Anu Logic Pro v3.6': 'qwen-2.5-coder-32b',
      'Anu Scout Engine v3.6': 'llama-3.1-8b-instant'
    };

    // Pick valid Groq model or default to llama-3.3-70b-versatile
    const selectedGroqModel = MODEL_MAPPING[model] || 'llama-3.3-70b-versatile';

    // Filter system directives or clean payload if needed
    const cleanedMessages = Array.isArray(messages) ? messages : [];

    // 3. Dispatch call to Groq API
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: selectedGroqModel,
        messages: cleanedMessages,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMessage = data.error?.message || JSON.stringify(data.error) || 'Groq API request failed';
      return res.status(response.status).json({ error: errorMessage });
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Proxy Error: ' + error.message });
  }
}
