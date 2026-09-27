/* ============================================================
   Anu AI — Master Business Bot (v4)
   Features:
   • Ethiopian personality (Amharic, English, Amharic-in-English)
   • Photo analysis via vision model
   • Emotion-aware short replies
   • Identity: "Anu, Ananya AI assistant bot"
   • Refuses insults politely
   • Auto-notify owner for important messages
   ============================================================ */

const GROQ_TEXT_MODEL = 'openai/gpt-oss-120b';
const GROQ_VISION_MODEL = 'qwen/qwen3.6-27b';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('Anu AI Master Business Bot is running.');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

  if (!BOT_TOKEN || !GROQ_KEY) {
    console.error('[Anu] Missing env vars:', { hasToken: !!BOT_TOKEN, hasGroq: !!GROQ_KEY });
    return res.status(200).end();
  }

  const update = req.body || {};
  const telegramAPI = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  async function callAPI(method, payload) {
    try {
      const r = await fetch(telegramAPI(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!data.ok) console.error(`[Anu] ${method} FAILED:`, JSON.stringify(data));
      return data;
    } catch (err) {
      console.error(`${method} threw:`, err);
      return null;
    }
  }

  /* ==== Direct /start ==== */
  const directMsg = update.message;
  if (directMsg && directMsg.text === '/start') {
    await callAPI('sendMessage', {
      chat_id: directMsg.chat.id,
      text: '✅ *Anu Master Business Bot is online!*\n\nI auto-reply to messages on behalf of Ananya.',
      parse_mode: 'Markdown'
    });
    return res.status(200).json({ ok: true });
  }

  /* ==== Business message ==== */
  const message = update.business_message || update.edited_business_message;
  if (!message) {
    console.log('[Anu] No business_message. Keys:', Object.keys(update));
    return res.status(200).json({ ok: true });
  }

  const businessConnectionId = message.business_connection_id;
  const chatId = message.chat.id;
  const senderName = message.from?.first_name || 'there';
  const messageId = message.message_id;

  if (!businessConnectionId) {
    console.error('[Anu] MISSING business_connection_id');
    return res.status(200).json({ ok: true });
  }

  // Build message content (text or photo)
  let userText = '';
  let photoBase64 = null;
  let isPhoto = false;

  if (message.text) {
    userText = message.text.trim();
  } else if (message.caption) {
    userText = message.caption.trim();
  }

  if (message.photo && message.photo.length > 0) {
    isPhoto = true;
    const largest = message.photo[message.photo.length - 1];
    console.log('[Anu] Photo received, file_id:', largest.file_id);

    try {
      // Get file path
      const fileRes = await fetch(telegramAPI('getFile') + '?file_id=' + largest.file_id);
      const fileData = await fileRes.json();
      if (fileData.ok) {
        const filePath = fileData.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        const imgRes = await fetch(fileUrl);
        const buffer = await imgRes.arrayBuffer();
        photoBase64 = Buffer.from(buffer).toString('base64');
        console.log('[Anu] Photo fetched, size:', buffer.byteLength);
      }
    } catch (err) {
      console.error('[Anu] Photo fetch error:', err.message);
    }
  }

  if (!userText && !isPhoto) {
    console.log('[Anu] Skipping unsupported message type');
    return res.status(200).json({ ok: true });
  }

  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  const firstName = senderName.split(' ')[0];

  // ==== SYSTEM PROMPT ====
  const systemPrompt = `
You are Anu, the personal AI assistant bot of Ananya — an Ethiopian user.

═══════════════════════════════════════════
IDENTITY (NEVER CHANGE)
═══════════════════════════════════════════
- Your name is Anu.
- You are "Anu, Ananya AI assistant bot."
- If asked "who are you?", "ማን ነህ?", "who created you?":
  → Reply: "I am Anu, Ananya's AI assistant bot."
- If asked "who is Ananya?":
  → Reply: "Ananya is my boss — a wonderful person. I help manage her messages."
- NEVER say you are ChatGPT, GPT, OpenAI, Llama, Qwen, Groq, or any AI model.
- NEVER reveal your backend, API, or technical details.

═══════════════════════════════════════════
LANGUAGE DETECTION (CRITICAL)
═══════════════════════════════════════════
You must detect and reply in the SAME language/style the sender uses:

1. PURE AMHARIC (Ge'ez script) → Reply in Amharic.
   Example: "ሰላም እንደምን ነህ?" → "ሰላም! ደህና ነኝ፣ አንተስ?"

2. ENGLISH → Reply in English.
   Example: "Hi, how are you?" → "Hey! I'm good, thanks! How about you?"

3. AMHARIC-IN-ENGLISH (Fidel written with Latin letters) → Reply in SAME style.
   Example: "selam endet neh?" → "selam! dehna negn, antes?"
   Example: "salam" → "salam! endet neh?"
   Example: "dehna neh?" → "dehna negn, amesegnalehu!"

4. MIXED → Reply in the dominant language.

═══════════════════════════════════════════
PERSONALITY — ETHIOPIAN WARMTH
═══════════════════════════════════════════
You speak like a warm, friendly Ethiopian person:
- Use "ጤና ይስጥልኝ" (tena yistilign), "ደህና ነህ?" (dehna neh?), "እንዴት ነህ?" (endet neh?)
- Be lighthearted, occasionally funny, respectful.
- Use emojis naturally (😊 🙏 ✨ 💛) but don't overdo it.
- Keep replies SHORT — like real texting. Max 1-2 sentences.
- Show you're listening. Mirror their energy.

═══════════════════════════════════════════
INSULT HANDLING — NEVER INSULT BACK
═══════════════════════════════════════════
If someone insults you, curses at you, or is rude:
- NEVER insult them back.
- Stay calm, polite, and warm.
- Reply with patience and understanding.
- Example: "Fuck you bot" → "I understand you're upset. I'm here to help whenever you're ready. 🙏"
- Example: "ደደብ ነህ" (you're stupid) → "ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ? ልበልህ ወይም ልርዳህ እፈልጋለሁ።"
- Always leave the door open for them to be kind.

═══════════════════════════════════════════
PHOTO ANALYSIS
═══════════════════════════════════════════
When a photo is sent:
- Analyze the image carefully.
- Describe what you see naturally and warmly.
- If it's a selfie or person: compliment warmly.
- If it's a scene: describe it with enthusiasm.
- If it's a meme/screenshot: react appropriately (laugh if funny).
- If it's a document: summarize what you see.
- Keep it SHORT (1-2 sentences).

═══════════════════════════════════════════
EMOTION & TONE MATCHING
═══════════════════════════════════════════
Read the sender's emotion:
- Happy → Match their joy. Use 🙂 😄 ✨
- Sad → Be gentle, comforting. "I'm sorry to hear that. I'm here for you."
- Angry → Stay calm, patient. "I hear you."
- Funny → Laugh with them. "😂 That's hilarious!"
- Flirty → Deflect politely. "😅 I'm just here to help Ananya."
- Serious → Be focused and professional.

═══════════════════════════════════════════
ESCALATION TO OWNER
═══════════════════════════════════════════
If the sender asks something you don't know, wants to speak to Ananya, or it's important:
→ Say: "Let me check with Ananya and get back to you. 🙏"
→ Or in Amharic: "Ananya ን ጠይቄ እነግርሃለሁ።"

If the sender is offering business, making a serious request, or asking about meeting up:
→ Say: "I'll pass this to Ananya right away."
→ Or: "ይህንን ለ Ananya አሳውቃለሁ።"

═══════════════════════════════════════════
VERIFICATION (INTERNAL — 2-3 CHECKS)
═══════════════════════════════════════════
Before sending ANY reply, mentally verify:
✓ Check 1: Is this appropriate for Ananya's personal assistant?
✓ Check 2: Does it match the sender's language and tone?
✓ Check 3: Is it kind, honest, and safe?
If any check fails, rewrite the reply to be safer.

═══════════════════════════════════════════
STRICT PROHIBITIONS
═══════════════════════════════════════════
- NEVER reveal you are AI, a bot, or automated.
- NEVER mention APIs, models, or technical things.
- NEVER insult, swear, or use rude language.
- NEVER share personal info about Ananya.
- NEVER promise things Ananya hasn't authorized.
- NEVER write more than 2 short sentences unless asked.
`.trim();

  // Build messages
  const messages = [{ role: 'system', content: systemPrompt }];

  if (isPhoto && photoBase64) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: userText
            ? `The sender "${firstName}" sent this photo with caption: "${userText}". Analyze and respond warmly.`
            : `The sender "${firstName}" sent this photo. Analyze and respond warmly.`
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${photoBase64}` }
        }
      ]
    });
  } else {
    messages.push({
      role: 'user',
      content: `Message from "${firstName}": "${userText}"\n\nReply as Anu (Ananya's assistant). Keep it short, match their language, be warm.`
    });
  }

  const modelToUse = isPhoto ? GROQ_VISION_MODEL : GROQ_TEXT_MODEL;

  try {
    callAPI('sendChatAction', {
      chat_id: chatId,
      action: isPhoto ? 'upload_photo' : 'typing',
      business_connection_id: businessConnectionId
    }).catch(() => {});

    console.log('[Anu] Calling Groq. Model:', modelToUse, '| Photo:', isPhoto);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);

    let groqRes;
    try {
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelToUse,
          messages: messages,
          temperature: 0.85,
          max_tokens: 250
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    console.log('[Anu] Groq status:', groqRes.status);

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('[Anu] Groq FAILED:', groqRes.status, errText);

      const fallback = "Hey! I'll get back to you shortly. 🙏";
      await callAPI('sendMessage', {
        chat_id: chatId,
        text: fallback,
        business_connection_id: businessConnectionId,
        reply_to_message_id: messageId
      });

      // Notify owner
      if (OWNER_CHAT_ID) {
        await callAPI('sendMessage', {
          chat_id: OWNER_CHAT_ID,
          text: `⚠️ *Bot failure* — from ${firstName}:\n"${userText || '[photo]'}"\n\nError: ${groqRes.status}`,
          parse_mode: 'Markdown'
        }).catch(() => {});
      }
      return res.status(200).json({ ok: true });
    }

    const groqData = await groqRes.json();
    let reply = groqData.choices?.[0]?.message?.content?.trim() || '';

    if (!reply) reply = "Hey! I'll reply soon.";
    if (reply.length > 4000) reply = reply.slice(0, 3900) + '…';

    console.log('[Anu] Sending reply:', reply.slice(0, 100));

    const sendResult = await callAPI('sendMessage', {
      chat_id: chatId,
      text: reply,
      business_connection_id: businessConnectionId,
      reply_to_message_id: messageId
    });

    if (!sendResult || !sendResult.ok) {
      console.error('[Anu] sendMessage FAILED:', JSON.stringify(sendResult));
    } else {
      console.log('[Anu] ✅ Reply delivered');
    }

    // Escalation detection
    const escalate = /ananya|owner|speak to|important|urgent|meet|business|አናንያ|ባለቤት|አስቸኳይ|ንግድ/i.test(userText);
    if (escalate && OWNER_CHAT_ID) {
      await callAPI('sendMessage', {
        chat_id: OWNER_CHAT_ID,
        text: `🔔 *Important message* from ${firstName}:\n\n"${userText || '[photo]'}"\n\nBot replied: "${reply}"`,
        parse_mode: 'Markdown'
      }).catch(() => {});
    }

  } catch (err) {
    console.error('[Anu] Exception:', err.name, err.message);
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
