// api/chat.js - Clean Production Handler for Groq API
export default async function handler(req, res) {
  // 1. CORS Headers Setup
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
    const { messages } = req.body || {};
    const rawApiKey = process.env.GROQ_API_KEY;

    if (!rawApiKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY is missing in Vercel Environment Variables.' });
    }

    const apiKey = rawApiKey.trim();

    // 2. Message Payload Sanitization
    let cleanedMessages = [];
    if (Array.isArray(messages)) {
      cleanedMessages = messages
        .filter(msg => msg && msg.role && msg.content)
        .map(msg => ({
          role: String(msg.role),
          content: String(msg.content)
        }));
    }

    if (cleanedMessages.length === 0) {
      cleanedMessages = [{ role: 'user', content: 'Hi' }];
    }

    // 3. Active & Guaranteed Groq Models (Deprecated models like gemma2 are removed)
    const ACTIVE_MODELS = [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'llama3-70b-8192',
      'llama3-8b-8192',
      'mixtral-8x7b-32768'
    ];

    let errorsLog = [];

    // 4. Try active models sequentially
    for (const modelName of ACTIVE_MODELS) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelName,
            messages: cleanedMessages,
            temperature: 0.7
          })
        });

        const data = await response.json();

        if (response.ok && data.choices && data.choices.length > 0) {
          return res.status(200).json(data);
        }

        const errDetail = data.error?.message || JSON.stringify(data);
        errorsLog.push(`${modelName}: ${errDetail}`);
      } catch (err) {
        errorsLog.push(`${modelName}: ${err.message}`);
      }
    }

    return res.status(400).json({ 
      error: 'Groq API Request Failed. Details: ' + errorsLog.join(' | ') 
    });

  } catch (error) {
    return res.status(500).json({ error: 'Server Error: ' + error.message });
  }
}
