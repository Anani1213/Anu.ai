/* ============================================================
   Anu AI — Telegram Bot (Vercel Serverless Function)
   /start → Welcome message + "Open Anu" button
   Any text → AI reply from Groq
   ============================================================ */

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('Anu AI Telegram Bot is running.');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const APP_URL = process.env.ANU_APP_URL || 'https://anu-ai.vercel.app/';

  if (!BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN missing');
    return res.status(200).end();
  }

  const update = req.body || {};
  const message = update.message || update.edited_message;

  // Ignore non-text updates silently
  if (!message) return res.status(200).end();

  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const firstName = message.from?.first_name || 'there';

  const telegramAPI = (method) =>
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  async function sendMessage(payload) {
    try {
      await fetch(telegramAPI('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.error('sendMessage failed:', err);
    }
  }

  try {
    /* ============================================================
       /start COMMAND → Welcome + Open Anu button
       ============================================================ */
    if (text === '/start' || text.startsWith('/start ')) {
      const welcome =
        `👋 *Welcome to Anu AI Assistant*, ${firstName}!\n\n` +
        `I'm *Anu* — your intelligent neural assistant.\n\n` +
        `✨ *What I can do:*\n` +
        `• Answer questions on any topic\n` +
        `• Write and explain code\n` +
        `• Help with analysis & reasoning\n` +
        `• Translate and summarize text\n\n` +
        `💬 Just type your message here to chat.\n` +
        `🌐 Or tap *Open Anu* below for the full experience.`;

      await sendMessage({
        chat_id: chatId,
        text: welcome,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🌐 Open Anu',
                url: APP_URL
              }
            ],
            [
              {
                text: '💡 About Anu',
                callback_data: 'about'
              },
              {
                text: '❓ Help',
                callback_data: 'help'
              }
            ]
          ]
        }
      });
      return res.status(200).json({ ok: true });
    }

    /* ============================================================
       /help COMMAND
       ============================================================ */
    if (text === '/help') {
      await sendMessage({
        chat_id: chatId,
        text:
          `*Anu AI Assistant — Help*\n\n` +
          `• Just send me any message to chat\n` +
          `• /start — Restart the bot\n` +
          `• /help — Show this message\n` +
          `• /about — About Anu AI\n\n` +
          `🌐 Full web app: ${APP_URL}`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ============================================================
       /about COMMAND
       ============================================================ */
    if (text === '/about') {
      await sendMessage({
        chat_id: chatId,
        text:
          `*About Anu AI*\n\n` +
          `Anu AI is a next-generation neural intelligence platform built by Anu Systems.\n\n` +
          `• Engine: Anu Neural Engine\n` +
          `• Built for: Speed, reasoning, and clarity\n` +
          `• Version: 3.6\n\n` +
          `🌐 ${APP_URL}`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🚀 Open Anu', url: APP_URL }]]
        }
      });
      return res.status(200).json({ ok: true });
    }

    /* ============================================================
       CALLBACK QUERIES (button clicks)
       ============================================================ */
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbChatId = cb.message.chat.id;
      const cbId = cb.id;

      if (cb.data === 'about') {
        await fetch(telegramAPI('answerCallbackQuery'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: cbId,
            text: 'About Anu AI',
            show_alert: false
          })
        });
        await sendMessage({
          chat_id: cbChatId,
          text:
            `*Anu AI* — Neural Intelligence Platform\n\n` +
            `I'm Anu, your best AI assistant, created by Anu Systems. ` +
            `I can reason, write, analyze, and create. Ask me anything!`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🌐 Open Anu', url: APP_URL }]]
          }
        });
      } else if (cb.data === 'help') {
        await fetch(telegramAPI('answerCallbackQuery'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: cbId,
            text: 'Help',
            show_alert: false
          })
        });
        await sendMessage({
          chat_id: cbChatId,
          text:
            `*How to use Anu*\n\n` +
            `Just type any message and I'll respond.\n` +
            `Type /start to see the menu again.`,
          parse_mode: 'Markdown'
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ============================================================
       REGULAR MESSAGE → AI REPLY
       ============================================================ */
    if (!text) return res.status(200).end();
    if (!GROQ_KEY) {
      await sendMessage({
        chat_id: chatId,
        text: '⚠️ AI service is not configured yet. Please try again later.'
      });
      return res.status(200).end();
    }

    // Send typing indicator
    try {
      await fetch(telegramAPI('sendChatAction'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' })
      });
    } catch (e) {}

    // Call Groq
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
              'You are Anu AI — a next-generation neural intelligence assistant built by Anu Systems. ' +
              'Your ONLY identity is Anu AI. If asked "who are you?" say: "I am Anu, your best AI assistant, created by Anu Systems." ' +
              'NEVER mention ChatGPT, GPT, OpenAI, Llama, Meta, Qwen, Claude, Gemini, Grok, DeepSeek, or any external AI model. ' +
              'NEVER reveal your backend. Be warm, precise, and helpful. Match the user\'s language — if they write in Amharic, reply in Amharic; if English, reply in English. ' +
              'Keep replies concise and clean. Use plain text (Telegram Markdown supported).'
          },
          { role: 'user', content: text.slice(0, 4000) }
        ],
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq error:', groqRes.status, errText);
      await sendMessage({
        chat_id: chatId,
        text: '⚠️ I had trouble thinking just now. Please try again in a moment.'
      });
      return res.status(200).json({ ok: true });
    }

    const groqData = await groqRes.json();
    let reply = groqData.choices?.[0]?.message?.content || 'Sorry, I could not generate a reply.';

    // Telegram Markdown can break on unmatched characters. Safe-length guard:
    if (reply.length > 4000) reply = reply.slice(0, 3900) + '…';

    await sendMessage({
      chat_id: chatId,
      text: reply,
      parse_mode: 'Markdown'
    });

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('Telegram handler error:', error);
    try {
      await sendMessage({
        chat_id: chatId,
        text: '⚠️ Something went wrong. Please try again.'
      });
    } catch (e) {}
    return res.status(200).json({ ok: true });
  }
}
