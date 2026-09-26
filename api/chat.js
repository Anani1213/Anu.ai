/* ============================================================
   Anu AI — Vercel Serverless Function
   Proxies chat requests to Groq while keeping the API key secret.
   ============================================================ */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.error('[Anu] GROQ_API_KEY missing from environment.');
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body || {})
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('[Anu] Groq error:', upstream.status, errText);
      return res.status(upstream.status).json({
        error: 'Upstream error',
        status: upstream.status,
        details: errText.slice(0, 500)
      });
    }

    if (req.body && req.body.stream && upstream.body) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (streamErr) {
        console.error('[Anu] Stream error:', streamErr);
      } finally {
        res.end();
      }
      return;
    }

    const data = await upstream.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('[Anu] Handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
