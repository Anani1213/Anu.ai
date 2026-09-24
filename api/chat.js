// api/chat.js - Vercel Serverless Function with full CORS Support
export default async function handler(req, res) {
  // 1. CORS Headers ሙሉ በሙሉ መፍቀድ
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  // 2. ብራውዘሩ የሚልከውን የ 'OPTIONS' preflight ጥሪ ወዲያውኑ ፍቀድ
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, model } = req.body || {};

    // GROQ_API_KEY መኖሩን ማረጋገጥ
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY is missing in Vercel Environment Variables.' });
    }

    // ወደ Groq API ጥሪ ማድረግ
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || "llama-3.3-70b-versatile",
        messages: messages || [],
        temperature: 0.7
      })
    });

    const data = await response.json();
    return res.status(response.status).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Proxy Error: ' + error.message });
  }
}
