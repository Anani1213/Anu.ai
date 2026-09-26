// api/chat.js - Groq Strict Model Mapper
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
    const apiKey = (process.env.GROQ_API_KEY || '').trim();

    if (!apiKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY is missing in Vercel Environment Variables.' });
    }

    // Map your custom frontend IDs to active working Groq models
    const MODEL_MAPPING = {
      'openai/gpt-oss-120b': ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
      'openai/gpt-oss-20b': ['llama-3.1-8b-instant'],
      'qwen/qwen3-32b': ['qwen-2.5-coder-32b', 'llama-3.1-8b-instant'],
      'meta-llama/llama-4-scout-17b-16e-instruct': ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']
    };

    const candidateModels = MODEL_MAPPING[model] || ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];

    let cleanedMessages = Array.isArray(messages)
      ? messages.filter(m => m && m.role && m.content).map(m => ({ role: String(m.role), content: String(m.content) }))
      : [{ role: 'user', content: 'Hi' }];

    let lastError = '';

    for (const targetModel of candidateModels) {
      try {
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

        if (response.ok && data.choices && data.choices.length > 0) {
          return res.status(200).json(data);
        }

        lastError = data.error?.message || JSON.stringify(data.error);
      } catch (err) {
        lastError = err.message;
      }
    }

    return res.status(400).json({ error: 'Groq Request Failed: ' + lastError });

  } catch (error) {
    return res.status(500).json({ error: 'Proxy Error: ' + error.message });
  }
}
