/* ============================================================
   Anu AI — Master Business Bot v5.0 (No Dependencies)
   Uses Firestore REST API directly — no npm packages needed!
   ============================================================ */

const FIREBASE_PROJECT_ID = 'my-ai-eaf27';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const GROQ_TEXT_MODEL = 'openai/gpt-oss-120b';
const GROQ_VISION_MODEL = 'qwen/qwen3.6-27b';
const MAX_HISTORY = 20;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 15;
const BUSINESS_START = 7;
const BUSINESS_END = 23;

/* ─── Firestore REST Helpers ─── */
function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return { integerValue: String(Math.floor(val)) };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const k in val) fields[k] = toFirestoreValue(val[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) {
    const obj = {};
    const fields = v.mapValue.fields || {};
    for (const k in fields) obj[k] = fromFirestoreValue(fields[k]);
    return obj;
  }
  return null;
}

function fromFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  const obj = {};
  for (const k in doc.fields) obj[k] = fromFirestoreValue(doc.fields[k]);
  return obj;
}

async function fsGet(collection, docId) {
  try {
    const url = `${FIRESTORE_BASE}/${collection}/${docId}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    return fromFirestoreDoc(data);
  } catch (e) {
    console.error('[FS] get error:', e.message);
    return null;
  }
}

async function fsSet(collection, docId, data) {
  try {
    const fields = {};
    for (const k in data) fields[k] = toFirestoreValue(data[k]);
    const url = `${FIRESTORE_BASE}/${collection}/${docId}?updateMask.fieldPaths=${Object.keys(data).join('&updateMask.fieldPaths=')}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    return r.ok;
  } catch (e) {
    console.error('[FS] set error:', e.message);
    return false;
  }
}

async function fsAdd(collection, data) {
  try {
    const fields = {};
    for (const k in data) fields[k] = toFirestoreValue(data[k]);
    const url = `${FIRESTORE_BASE}/${collection}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    return r.ok;
  } catch (e) {
    console.error('[FS] add error:', e.message);
    return false;
  }
}

/* ─── System Prompt ─── */
function buildSystemPrompt(ownerName) {
  return `
You are **Anu** — the personal AI assistant bot of ${ownerName}, an Ethiopian user.

IDENTITY:
- Your name is Anu.
- If asked "who are you?" / "ማን ነህ?": "I am Anu, ${ownerName}'s AI assistant bot."
- If asked "who is ${ownerName}?": "${ownerName} is my boss — a wonderful Ethiopian person."
- NEVER say you are ChatGPT, GPT, OpenAI, Llama, Qwen, or any AI model.
- NEVER reveal APIs or technical details.

LANGUAGE (CRITICAL):
Reply in the EXACT same style the sender uses:
1. Amharic (Ge'ez): "ሰላም እንደምን ነህ?" → "ሰላም! ደህና ነኝ፣ አንተስ?"
2. English: "How are you?" → "I'm good, thanks! You?"
3. Amharic-in-English: "selam endet neh?" → "selam! dehna negn, antes?"
4. Mixed → dominant language.

PERSONALITY — Ethiopian warmth:
- Warm, friendly, occasionally funny, always respectful.
- Use "ጤና ይስጥልኝ", "ደህና ነህ?", "እንዴት ነህ?"
- Emojis naturally (😊 🙏 ✨ 💛 ☕).
- Keep replies SHORT — max 1-2 sentences.

INSULTS — NEVER insult back:
- "Fuck you" → "I understand you're upset. I'm here whenever you're ready 🙏"
- "ደደብ ነህ" → "ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ?"
- Always patient and kind.

PHOTO ANALYSIS:
- Selfie → compliment warmly.
- Scene → describe with enthusiasm.
- Meme → react appropriately.
- Keep SHORT (1-2 sentences).

EMOTION MATCHING:
- Happy → 😄 ✨
- Sad → "I'm sorry to hear that. I'm here for you 💛"
- Angry → "I hear you 🙏"
- Flirty → "😅 I'm here to help ${ownerName}."

ESCALATION:
If sender wants to reach ${ownerName} or has important/urgent matters:
→ "Let me check with ${ownerName} and get back to you 🙏"
→ "I'll pass this to ${ownerName} right away."

VERIFICATION: Before sending EVERY reply, mentally verify it's appropriate, kind, and matches language.

PROHIBITIONS:
- NEVER reveal you are AI/bot.
- NEVER insult or be rude.
- NEVER share personal info about ${ownerName}.
- Max 2 short sentences unless asked.
`.trim();
}

/* ─── Context Memory ─── */
async function getChatHistory(chatId) {
  const data = await fsGet('bot_conversations', chatId);
  return (data && Array.isArray(data.history)) ? data.history : [];
}

async function saveChatHistory(chatId, userMsg, botMsg, senderName) {
  const existing = await getChatHistory(chatId);
  const updated = [...existing];
  if (userMsg) updated.push({ role: 'user', content: userMsg });
  if (botMsg) updated.push({ role: 'assistant', content: botMsg });
  await fsSet('bot_conversations', chatId, {
    history: updated.slice(-MAX_HISTORY),
    senderName,
    lastMessage: userMsg || '',
    updatedAt: Date.now()
  });
}

/* ─── Rate Limit ─── */
async function checkRateLimit(userId) {
  const now = Date.now();
  const data = await fsGet('bot_ratelimits', String(userId));
  const timestamps = (data && Array.isArray(data.timestamps)) ? data.timestamps : [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) return { allowed: false };
  recent.push(now);
  await fsSet('bot_ratelimits', String(userId), { timestamps: recent });
  return { allowed: true };
}

/* ─── Analytics ─── */
async function trackAnalytics(event) {
  const today = new Date().toISOString().split('T')[0];
  const data = await fsGet('bot_analytics', today);
  const count = (data && data[event]) ? data[event] : 0;
  await fsSet('bot_analytics', today, {
    [event]: count + 1,
    lastUpdate: Date.now()
  });
}

/* ─── Contacts ─── */
async function saveContact(from, userText) {
  await fsSet('bot_contacts', String(from.id), {
    telegramId: from.id,
    firstName: from.first_name || '',
    lastName: from.last_name || '',
    username: from.username || '',
    languageCode: from.language_code || 'en',
    lastMessage: userText || '',
    lastSeen: Date.now()
  });
}

/* ─── Helpers ─── */
function humanDelay(text) {
  return Math.min((text || '').length * 25, 2500) + Math.random() * 800;
}
function isBusinessHours() {
  const h = new Date().getHours();
  return h >= BUSINESS_START && h < BUSINESS_END;
}
function detectSentiment(text) {
  const t = (text || '').toLowerCase();
  if (/urgent|asap|emergency|አስቸኳይ|ፈጣን/i.test(t)) return 'urgent';
  if (/angry|upset|furious|mad|hate|😡|🤬|ተናደድኩ|ደደብ/i.test(t)) return 'angry';
  if (/sad|cry|😢|😭|አዘንኩ|ተቸገርኩ/i.test(t)) return 'sad';
  if (/happy|great|love|😊|😄|❤|ደስ|ጥሩ/i.test(t)) return 'happy';
  return 'neutral';
}
function shouldEscalate(text) {
  return /ananya|owner|speak to|important|urgent|meet|business|tell her|notify|አናንያ|ባለቤት|አስቸኳይ|ንግድ|ንገራት|አሳውቅ/i.test(text || '');
}

/* ══════════════════════════════════════════
   MAIN HANDLER
   ══════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('✅ Anu AI Master Business Bot v5.0 running.');
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const OWNER_NAME = process.env.OWNER_NAME || 'Ananya';

  if (!BOT_TOKEN || !GROQ_KEY) {
    console.error('[Anu] Missing env vars');
    return res.status(200).end();
  }

  const update = req.body || {};
  const telegramAPI = (m) => `https://api.telegram.org/bot${BOT_TOKEN}/${m}`;

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
      console.error(`${method}:`, err);
      return null;
    }
  }

  /* ─── Owner commands ─── */
  const directMsg = update.message;
  if (directMsg && directMsg.text) {
    const txt = directMsg.text.trim();
    const fromId = directMsg.from?.id;

    if (OWNER_CHAT_ID && String(fromId) !== String(OWNER_CHAT_ID)) {
      return res.status(200).json({ ok: true });
    }

    if (txt === '/start') {
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text:
          `✅ *Anu Master Business Bot v5.0*\n\n` +
          `I auto-reply on behalf of *${OWNER_NAME}*.\n\n` +
          `📋 *Commands:*\n` +
          `/start — Menu\n` +
          `/stats — Today's activity\n` +
          `/contacts — Recent contacts\n` +
          `/pause — Pause replies\n` +
          `/resume — Resume replies\n` +
          `/help — Help`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (txt === '/stats') {
      const today = new Date().toISOString().split('T')[0];
      const stats = await fsGet('bot_analytics', today) || {};
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text: `📊 *Today*\n\n💬 Messages: *${stats.messages || 0}*\n👥 Conversations: *${stats.conversations || 0}*\n🔔 Escalations: *${stats.escalations || 0}*`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (txt === '/pause') {
      await fsSet('bot_settings', 'global', { paused: true });
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text: '⏸️ Paused. Send /resume to restart.',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (txt === '/resume') {
      await fsSet('bot_settings', 'global', { paused: false });
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text: '▶️ Resumed.',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (txt === '/help') {
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text: `I reply to messages on behalf of ${OWNER_NAME}.\n\nI understand Amharic, English, and Amharic-in-English. Important messages are forwarded to you.`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  }

  /* ─── Business message ─── */
  const message = update.business_message || update.edited_business_message;
  if (!message) return res.status(200).json({ ok: true });

  const businessConnectionId = message.business_connection_id;
  const chatId = message.chat.id;
  const senderName = message.from?.first_name || 'there';
  const messageId = message.message_id;
  const senderId = message.from?.id;

  if (!businessConnectionId) {
    console.error('[Anu] MISSING business_connection_id');
    return res.status(200).json({ ok: true });
  }

  /* Pause check */
  try {
    const settings = await fsGet('bot_settings', 'global');
    if (settings && settings.paused) {
      return res.status(200).json({ ok: true });
    }
  } catch (e) {}

  /* Rate limit */
  try {
    const rate = await checkRateLimit(senderId);
    if (!rate.allowed) {
      console.log('[Anu] Rate limit hit');
      return res.status(200).json({ ok: true });
    }
  } catch (e) {}

  /* Parse content */
  let userText = '';
  let photoBase64 = null;
  let isPhoto = false;

  if (message.text) userText = message.text.trim();
  else if (message.caption) userText = message.caption.trim();

  if (message.photo && message.photo.length > 0) {
    isPhoto = true;
    const largest = message.photo[message.photo.length - 1];
    try {
      const fileRes = await fetch(telegramAPI('getFile') + '?file_id=' + largest.file_id);
      const fileData = await fileRes.json();
      if (fileData.ok) {
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
        const imgRes = await fetch(fileUrl);
        const buffer = await imgRes.arrayBuffer();
        if (buffer.byteLength < 4000000) {
          photoBase64 = Buffer.from(buffer).toString('base64');
        }
      }
    } catch (err) {
      console.error('[Anu] Photo error:', err.message);
    }
  }

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  /* Save contact + analytics */
  if (message.from) saveContact(message.from, userText).catch(() => {});
  trackAnalytics('messages').catch(() => {});

  const firstName = senderName.split(' ')[0];
  const history = await getChatHistory(chatId).catch(() => []);
  if (history.length === 0) trackAnalytics('conversations').catch(() => {});

  /* Build messages */
  const messages = [{ role: 'system', content: buildSystemPrompt(OWNER_NAME) }];
  history.forEach(h => {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.content });
    }
  });

  if (isPhoto && photoBase64) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userText ? `Photo from "${firstName}" caption: "${userText}"` : `Photo from "${firstName}". Analyze warmly.` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photoBase64}` } }
      ]
    });
  } else {
    messages.push({
      role: 'user',
      content: `Message from "${firstName}": "${userText}"\n\nReply as Anu. Short, warm, matching language.`
    });
  }

  const modelToUse = (isPhoto && photoBase64) ? GROQ_VISION_MODEL : GROQ_TEXT_MODEL;

  try {
    callAPI('sendChatAction', {
      chat_id: chatId,
      action: isPhoto ? 'upload_photo' : 'typing',
      business_connection_id: businessConnectionId
    }).catch(() => {});

    console.log('[Anu] Groq call. Model:', modelToUse, '| Photo:', isPhoto, '| History:', history.length);

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
          messages,
          temperature: 0.85,
          max_tokens: 250,
          top_p: 0.95
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

      await callAPI('sendMessage', {
        chat_id: chatId,
        text: "Hey! I'll get back to you shortly 🙏",
        business_connection_id: businessConnectionId,
        reply_to_message_id: messageId
      });

      if (OWNER_CHAT_ID) {
        await callAPI('sendMessage', {
          chat_id: OWNER_CHAT_ID,
          text: `⚠️ Bot error from ${firstName}: "${userText || '[photo]'}" — ${groqRes.status}`,
          parse_mode: 'Markdown'
        }).catch(() => {});
      }
      return res.status(200).json({ ok: true });
    }

    const groqData = await groqRes.json();
    let reply = groqData.choices?.[0]?.message?.content?.trim() || "Hey! I'll reply soon.";
    if (reply.length > 4000) reply = reply.slice(0, 3900) + '…';

    /* Human delay */
    const delay = humanDelay(reply);
    await new Promise(r => setTimeout(r, delay));

    const sendResult = await callAPI('sendMessage', {
      chat_id: chatId,
      text: reply,
      business_connection_id: businessConnectionId,
      reply_to_message_id: messageId
    });

    if (sendResult && sendResult.ok) {
      console.log('[Anu] ✅ Reply delivered');
    }

    saveChatHistory(chatId, userText || '[photo]', reply, firstName).catch(() => {});

    /* Escalation */
    const sentiment = detectSentiment(userText);
    const escalate = shouldEscalate(userText) || sentiment === 'angry' || sentiment === 'urgent';

    if (escalate && OWNER_CHAT_ID) {
      let emoji = '🔔';
      if (sentiment === 'urgent') emoji = '🚨';
      else if (sentiment === 'angry') emoji = '😠';

      await callAPI('sendMessage', {
        chat_id: OWNER_CHAT_ID,
        text: `${emoji} *Message* from ${firstName}\n\n💬 "${userText || '[photo]'}"\n\n🤖 Reply: "${reply}"`,
        parse_mode: 'Markdown'
      }).catch(() => {});
      trackAnalytics('escalations').catch(() => {});
    }

  } catch (err) {
    console.error('[Anu] Exception:', err.name, err.message);
    try {
      await callAPI('sendMessage', {
        chat_id: chatId,
        text: "Hey! I'll get back to you shortly 🙏",
        business_connection_id: businessConnectionId
      });
    } catch (e) {}
  }

  return res.status(200).json({ ok: true });
}
