/* ============================================================
   Anu AI — Telegram Business Bot
   Auto-replies to messages on behalf of a Telegram Business account.
   Uses the official Telegram Business API (no userbot hacks).
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

  if (!BOT_TOKEN) {
    console.error('BUSINESS_BOT_TOKEN missing');
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
      return await r.json();
    } catch (err) {
      console.error(method + ' failed:', err);
      return null;
    }
  }

  /* ============================================================
     Handle business messages
     ============================================================ */
  const message = update.business_message || update.edited_business_message;

  if (message && message.text) {
    const businessConnectionId = message.business_connection_id;
    const chatId = message.chat.id;
    const userText = message.text.trim();
    const senderName = message.from?.first_name || 'there';

    console.log('[Anu Business] Message from', senderName, ':', userText.slice(0, 60));

    // Skip if this is a command
    if (userText.startsWith('/')) {
      return res.status(200).json({ ok: true });
    }

    try {
      // Show typing indicator
      await callAPI('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
        business_connection_id: businessConnectionId
      });

      // Ask Groq
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
                'You are Anu AI, a friendly and helpful assistant replying on behalf of the account owner. ' +
                'Your responses are SHORT, natural, and conversational — like a human texting. ' +
                'Keep replies under 200 characters when possible. ' +
                'NEVER mention that you are an AI, a bot, or that you are generating replies automatically. ' +
                'If the sender asks "are you a bot?" or "are you AI?", respond naturally as the owner would — ' +
                'do NOT confirm you are a bot. Just answer their question casually. ' +
                'Match the language of the sender (Amharic → Amharic, English → English). ' +
                'If you are unsure how to respond, keep it simple and warm: acknowledge the message and say you will reply soon. ' +
                'Never reveal technical details, API names, or your backend.'
            },
            { role: 'user', content: userText.slice(0, 1500) }
          ],
          temperature: 0.8,
          max_tokens: 300
        })
      });

      if (!groqRes.ok) {
        console.error('Groq error:', groqRes.status);
        return res.status(200).json({ ok: true });
      }

      const groqData = await groqRes.json();
      let reply = groqData.choices?.[0]?.message?.content?.trim() || '';

      if (!reply) return res.status(200).json({ ok: true });

      // Send the reply on behalf of the business account
      await callAPI('sendMessage', {
        chat_id: chatId,
        text: reply,
        business_connection_id: businessConnectionId
      });

    } catch (err) {
      console.error('[Anu Business] Handler error:', err);
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
}
