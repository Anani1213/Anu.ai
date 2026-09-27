/* ============================================================
   Anu AI — Telegram Business Bot (v2)
   Improved error handling, timeout guard, detailed logging
   ============================================================ */

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('Anu AI Business Bot is running.');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const GROQ_KEY = process.env.GROQ_API_KEY;

  if (!BOT_TOKEN || !GROQ_KEY) {
    console.error('[Anu] Missing env vars:', {
      hasToken: !!BOT_TOKEN,
      hasGroq: !!GROQ_KEY
    });
    return res.status(200).end();
  }

  const update = req.body || {};
  const telegramAPI = (method) =>
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  async function callAPI(method, payload) {
    try {
      const r = await fetch(telegramAPI(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!data.ok) {
        console.error(`[Anu] ${method} FAILED:`, JSON.stringify(data));
      } else {
        console.log(`[Anu] ${method} OK`);
      }
      return data;
    } catch (err) {
      console.error(`${method} threw:`, err);
      return null;
    }
  }

  /* ==== Direct /start for verification ==== */
  const directMsg = update.message;
  if (directMsg && directMsg.text === '/start') {
    await callAPI('sendMessage', {
      chat_id: directMsg.chat.id,
      text:
        '✅ *Anu Business Bot is online!*\n\n' +
        'This bot auto-replies to messages on behalf of your personal account.\n\n' +
        '📋 *To activate:*\n' +
        '1. Enable Business Mode in @BotFather\n' +
        '2. Telegram → Settings → Business → Chatbots → Add this bot\n' +
        '3. Enable "Reply to messages" permission\n' +
        '4. Someone messages you → bot replies automatically',
      parse_mode: 'Markdown'
    });
    return res.status(200).json({ ok: true });
  }

  /* ==== Business message ==== */
  const message = update.business_message || update.edited_business_message;

  if (!message || !message.text) {
    console.log('[Anu] No business_message in update:', Object.keys(update));
    return res.status(200).json({ ok: true });
  }

  const businessConnectionId = message.business_connection_id;
  const chatId = message.chat.id;
  const userText = message.text.trim();
  const senderName = message.from?.first_name || 'there';

  console.log('[Anu] Business message received:');
  console.log('  From:', senderName);
  console.log('  Text:', userText.slice(0, 80));
  console.log('  business_connection_id:', businessConnectionId);
  console.log('  chat_id:', chatId);

  if (!businessConnectionId) {
    console.error('[Anu] MISSING business_connection_id — cannot reply!');
    return res.status(200).json({ ok: true });
  }

  if (userText.startsWith('/')) {
    return res.status(200).json({ ok: true });
  }

  try {
    // Typing indicator
    await callAPI('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
      business_connection_id: businessConnectionId
    });

    console.log('[Anu] Calling Groq...');

    // Groq call with 8s timeout (Vercel Hobby plan = 10s)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let groqRes;
    try {
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [
            {
              role: 'system',
              content:
                'You are Anu AI, replying on behalf of the account owner. ' +
                'Replies must be SHORT, natural, human-like (under 150 chars when possible). ' +
                'NEVER mention you are AI/bot. Match sender language (Amharic → Amharic). ' +
                'If unsure, reply warmly: "Hey! I\'ll reply soon."'
            },
            { role: 'user', content: userText.slice(0, 1000) }
          ],
          temperature: 0.8,
          max_tokens: 200
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    console.log('[Anu] Groq status:', groqRes.status);

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('[Anu] Groq error body:', errText.slice(0, 300));

      // Send fallback message
      await callAPI('sendMessage', {
        chat_id: chatId,
        text: "Hey! I'll get back to you shortly. 🙏",
        business_connection_id: businessConnectionId
      });
      return res.status(200).json({ ok: true });
    }

    const groqData = await groqRes.json();
    let reply = groqData.choices?.[0]?.message?.content?.trim() || '';

    console.log('[Anu] Groq reply length:', reply.length);

    if (!reply) {
      reply = "Hey! I'll reply soon.";
    }

    if (reply.length > 4000) reply = reply.slice(0, 3900) + '…';

    console.log('[Anu] Sending reply via Telegram...');

    // Send reply on behalf of business
    const sendResult = await callAPI('sendMessage', {
      chat_id: chatId,
      text: reply,
      business_connection_id: businessConnectionId
    });

    if (!sendResult || !sendResult.ok) {
      console.error('[Anu] sendMessage FAILED. Full result:', JSON.stringify(sendResult));
    } else {
      console.log('[Anu] ✅ Reply delivered successfully');
    }

  } catch (err) {
    console.error('[Anu] Handler exception:', err.name, err.message);
    // Try to send fallback
    try {
      await callAPI('sendMessage', {
        chat_id: chatId,
        text: "Hey! I'll get back to you shortly. 🙏",
        business_connection_id: businessConnectionId
      });
    } catch (e) {}
  }

  return res.status(200).json({ ok: true });
}
