// api/chat.js

export default async function handler(req, res) {
  // 1. የ CORS ራስጌዎችን ያዘጋጁ (የእርስዎን የቀጥታ ጣቢያ አድራሻ ይተኩ)
  res.setHeader('Access-Control-Allow-Origin', 'https://your-app-name.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. የ OPTIONS ጥያቄን (Preflight) ያስተናግዱ
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. የ POST ጥያቄ ብቻ እንዲሆን ያረጋግጡ
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 4. የ Groq API key ን ከ Environment Variable ያንብቡ
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  try {
    // 5. ከ Frontend የመጣውን መረጃ ወደ Groq ይላኩ
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body) // req.body ከ frontend የመጣው ሙሉ payload ነው
    });

    // 6. ምላሹን ወደ Frontend ይላኩ
    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json(errorData);
    }

    // ለ Streaming (SSE) ምላሽ
    if (response.body) {
      // የ Content-Type ን ያስተላልፉ
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // የ Stream ን ወደ ውጭ ይላኩ
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value));
        }
      } catch (streamError) {
        console.error('Stream error:', streamError);
      } finally {
        res.end();
      }
      return;
    }

    // ለተለመደ (Non-streaming) ምላሽ
    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
