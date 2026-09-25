// api/chat.js - Smart Auto-Retry Multi-Model Handler
export default async function handler(req, res) {
  // 1. CORS Headers
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
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY is missing in Vercel Environment Variables.' });
    }

    // 2. የሚሰሩ የ Groq ሞዴሎች ዝርዝር (አንዱ 404 ካለ በራሱ ወደሚቀጥለው ይሸጋገራል)
    const CANDIDATE_MODELS = [
      'llama-3.1-8b-instant',
      'llama-3.3-70b-versatile',
      'mixtral-8x7b-32768',
      'gemma2-9b-it'
    ];

    let lastErrorMessage = '';

    // 3. ሞዴሎቹን በቅደም ተከተል በመሞከር የሚሰራውን መምረጥ
    for (const modelName of CANDIDATE_MODELS) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelName,
            messages: Array.isArray(messages) ? messages : [],
            temperature: 0.7
          })
        });

        const data = await response.json();

        if (response.ok && data.choices && data.choices.length > 0) {
          return res.status(200).json(data);
        }

        lastErrorMessage = data.error?.message || JSON.stringify(data.error);
      } catch (err) {
        lastErrorMessage = err.message;
      }
    }

    // ሁሉም ሞዴሎች ካልሰሩ የተፈጠረውን ኤረር ማሳየት
    return res.status(400).json({ error: 'All models failed. Details: ' + lastErrorMessage });

  } catch (error) {
    return res.status(500).json({ error: 'Proxy Server Error: ' + error.message });
  }
}
