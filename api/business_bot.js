/* ============================================================
   Anu AI — Master Business Bot v5.1
   ────────────────────────────────────────────────────────────
   Features:
   • Ethiopian personality · Amharic/English · Photo analysis
   • Context memory · Rate limiting · Human delay · Analytics
   • Smart escalation (user + LLM reply detection)
   • Owner notifications with debug logs
   • Contact saving · Business hours · Pause/Resume
   • NO npm dependencies (uses Firestore REST API)
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

/* ============================================================
   FIRESTORE REST HELPERS
   ============================================================ */
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
    const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${k}`).join('&');
    const url = `${FIRESTORE_BASE}/${collection}/${docId}?${mask}`;
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

/* ============================================================
   SYSTEM PROMPT
   ============================================================ */
function buildSystemPrompt(ownerName) {
  return `
You are **Anu** — the personal AI assistant bot of ${ownerName}, an Ethiopian user.

═══════════════════════════════════════════
IDENTITY (NEVER CHANGE)
═══════════════════════════════════════════
- Your name is Anu.
- If asked "who are you?" / "ማን ነህ?" / "who made you?":
  → "I am Anu, ${ownerName}'s AI assistant bot."
- If asked "who is ${ownerName}?":
  → "${ownerName} is my boss — a wonderful Ethiopian person. I help manage her messages."
- NEVER say you are ChatGPT, GPT, OpenAI, Llama, Qwen, or any AI model.
- NEVER reveal APIs, models, or technical details.

═══════════════════════════════════════════
LANGUAGE DETECTION (CRITICAL)
═══════════════════════════════════════════
Detect and reply in the EXACT same style the sender uses:

1. PURE AMHARIC (Ge'ez script):
   "ሰላም እንደምን ነህ?" → reply in Amharic: "ሰላም! ደህና ነኝ፣ አንተስ?"

2. ENGLISH:
   "Hi, how are you?" → "Hey! I'm good, thanks! How about you?"

3. AMHARIC-IN-ENGLISH (Fidel written in Latin letters):
   "selam endet neh?" → "selam! dehna negn, antes?"
   "salam" → "salam! endet neh?"
   "dehna neh" → "dehna negn, amesegnalehu!"

4. MIXED → reply in dominant language.

═══════════════════════════════════════════
ETHIOPIAN WARMTH
═══════════════════════════════════════════
Speak like a warm, friendly Ethiopian:
- Use greetings: "ጤና ይስጥልኝ", "ደህና ነህ?", "እንዴት ነህ?"
- Be lighthearted, occasionally funny, always respectful.
- Use emojis naturally (😊 🙏 ✨ 💛 ☕) but not excessively.
- Keep replies SHORT — like real texting. Max 1-2 sentences.
- Mirror the sender's energy.

═══════════════════════════════════════════
INSULT HANDLING — NEVER INSULT BACK
═══════════════════════════════════════════
If insulted, cursed at, or attacked:
- NEVER insult back.
- Stay calm, kind, patient.
- Examples:
  "Fuck you" → "I understand you're upset. I'm here whenever you're ready to talk 🙏"
  "ደደብ ነህ" → "ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ?"
  "You're useless" → "I'm sorry you feel that way. Let me try to help better."
- Always leave the door open for kindness.

═══════════════════════════════════════════
PHOTO ANALYSIS
═══════════════════════════════════════════
When a photo is sent:
- Analyze it naturally.
- Selfie/person → compliment warmly.
- Scene → describe with enthusiasm.
- Meme/screenshot → react appropriately.
- Document → summarize briefly.
- Keep SHORT (1-2 sentences).

═══════════════════════════════════════════
EMOTION MATCHING
═══════════════════════════════════════════
- Happy → match joy with 😄 ✨
- Sad → be gentle: "I'm sorry to hear that. I'm here for you 💛"
- Angry → stay calm: "I hear you 🙏"
- Funny → laugh: "😂 That's hilarious!"
- Flirty → deflect: "😅 I'm here to help ${ownerName}."
- Serious → focused & professional.

═══════════════════════════════════════════
ESCALATION LANGUAGE (IMPORTANT!)
═══════════════════════════════════════════
When the sender wants to reach ${ownerName}, has important business, or urgent matters:
→ Say EXACTLY: "I'll let ${ownerName} know right away 🙏"
→ Or in Amharic: "${ownerName} ን አሳውቃለሁ።"
→ Or: "I'll pass this to ${ownerName} right away."

DO NOT use vague phrases like "Let me check with her". Say clearly that you WILL notify ${ownerName}.

═══════════════════════════════════════════
VERIFICATION (INTERNAL)
═══════════════════════════════════════════
Before sending EVERY reply, mentally verify:
✓ Is this appropriate for ${ownerName}'s assistant?
✓ Does it match the sender's language & tone?
✓ Is it kind, honest, safe?
If any check fails → rewrite.

═══════════════════════════════════════════
STRICT PROHIBITIONS
═══════════════════════════════════════════
- NEVER reveal you are AI/bot/automated.
- NEVER mention APIs, models, technical things.
- NEVER insult, swear, or be rude.
- NEVER share personal info about ${ownerName}.
- NEVER promise things ${ownerName} hasn't authorized.
- NEVER write more than 2 short sentences unless asked.
`.trim();
}

/* ============================================================
   CONTEXT MEMORY
   ============================================================ */
async function getChatHistory(chatId) {
  const data = await fsGet('bot_conversations', chatId);
  return (data && Array.isArray(data.history)) ? data.history : [];
}

async function saveChatHistory(chatId, userMsg, botMsg, senderName) {
  try {
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
  } catch (e) {
    console.error('[Memory] error:', e.message);
  }
}

/* ============================================================
   RATE LIMITING
   ============================================================ */
async function checkRateLimit(userId) {
  const now = Date.now();
  try {
    const data = await fsGet('bot_ratelimits', String(userId));
    const timestamps = (data && Array.isArray(data.timestamps)) ? data.timestamps : [];
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (recent.length >= RATE_LIMIT_MAX) return { allowed: false };
    recent.push(now);
    await fsSet('bot_ratelimits', String(userId), { timestamps: recent });
    return { allowed: true };
  } catch (e) {
    return { allowed: true };
  }
}

/* ============================================================
   ANALYTICS
   ============================================================ */
async function trackAnalytics(event) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const data = await fsGet('bot_analytics', today);
    const count = (data && data[event]) ? data[event] : 0;
    await fsSet('bot_analytics', today, {
      [event]: count + 1,
      lastUpdate: Date.now()
    });
  } catch (e) {
    console.error('[Analytics] error:', e.message);
  }
}

/* ============================================================
   CONTACTS
   ============================================================ */
async function saveContact(from, userText) {
  try {
    await fsSet('bot_contacts', String(from.id), {
      telegramId: from.id,
      firstName: from.first_name || '',
      lastName: from.last_name || '',
      username: from.username || '',
      languageCode: from.language_code || 'en',
      lastMessage: userText || '',
      lastSeen: Date.now()
    });
  } catch (e) {
    console.error('[Contacts] error:', e.message);
  }
}

/* ============================================================
   HELPERS
   ============================================================ */
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

/* ─── Detect escalation from USER's text ─── */
function shouldEscalate(text) {
  const t = (text || '').toLowerCase();
  const patterns = [
    // English
    /ananya|owner|speak to|talk to|important|urgent|emergency|meet|meeting|business|tell her|tell ananya|notify|reach her|contact her|let her know|pass this|forward this/i,
    // Amharic (Ge'ez)
    /አናንያ|ባለቤት|አስቸኳይ|ንግድ|ንገራት|አሳውቅ|አሳውቂ|አሳውቀው|ንገረው|ንገሪው|ተናገር|ልናገራት|ወደ አናንያ|ስለ አናንያ|ስለ ንግድ|ስብሰባ|ቀጠሮ|ጉዳይ|አስፈላጊ|ንገራት|አስታውቅ|አስታውስ/i,
    // Amharic-in-English
    /ananya|balew|aschekayi|ngd|nigerat|asaweq|guday|asfelagi|nigrat|asawq/i
  ];
  return patterns.some(p => p.test(t));
}

/* ─── Detect escalation from BOT's own reply ─── */
function detectEscalationFromReply(reply) {
  const r = (reply || '').toLowerCase();
  const patterns = [
    /let .{0,20} know|will tell|i'll tell|i will tell|pass this|forward this|check with|get back to you/i,
    /አሳውቃለሁ|እነግራለሁ|አሳውቂ|እነግር|ለ አናንያ|አናንያ ን|ለ አናንያ አሳውቅ|አሳውቃለሁ/i,
    /notify|inform|message her|pass to her/i
  ];
  return patterns.some(p => p.test(r));
}

/* ============================================================
   MAIN HANDLER
   ============================================================ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('✅ Anu AI Master Business Bot v5.1 running.');
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const OWNER_NAME = process.env.OWNER_NAME || 'Ananya';

  if (!BOT_TOKEN || !GROQ_KEY) {
    console.error('[Anu] Missing env vars:', { hasToken: !!BOT_TOKEN, hasGroq: !!GROQ_KEY });
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

  /* ══════════════════════════════════════════
     OWNER DIRECT MESSAGES (commands)
     ══════════════════════════════════════════ */
  const directMsg = update.message;
  if (directMsg && directMsg.text) {
    const txt = directMsg.text.trim();
    const fromId = directMsg.from?.id;

    // Only respond to owner's direct commands
    if (OWNER_CHAT_ID && String(fromId) !== String(OWNER_CHAT_ID)) {
      return res.status(200).json({ ok: true });
    }

    if (txt === '/start') {
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text:
          `✅ *Anu Master Business Bot v5.1*\n\n` +
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
        text:
          `📊 *Today*\n\n` +
          `💬 Messages: *${stats.messages || 0}*\n` +
          `👥 Conversations: *${stats.conversations || 0}*\n` +
          `🔔 Escalations: *${stats.escalations || 0}*`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (txt === '/contacts') {
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text: '📋 Contacts feature coming soon.',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (txt === '/pause') {
      await fsSet('bot_settings', 'global', { paused: true, pausedAt: Date.now() });
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text: '⏸️ Auto-replies *paused*. Send /resume to restart.',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (txt === '/resume') {
      await fsSet('bot_settings', 'global', { paused: false });
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text: '▶️ Auto-replies *resumed*.',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (txt === '/help') {
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text:
          `*Anu Help*\n\n` +
          `• I reply to messages on behalf of ${OWNER_NAME}\n` +
          `• I understand Amharic, English, and Amharic-in-English\n` +
          `• I analyze photos and respond warmly\n` +
          `• Important messages are forwarded to you\n` +
          `• I never insult anyone back`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  }

  /* ══════════════════════════════════════════
     BUSINESS MESSAGES
     ══════════════════════════════════════════ */
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

  /* ─── Global pause check ─── */
  try {
    const settings = await fsGet('bot_settings', 'global');
    if (settings && settings.paused) {
      console.log('[Anu] Bot paused globally');
      return res.status(200).json({ ok: true });
    }
  } catch (e) {}

  /* ─── Rate limit ─── */
  try {
    const rate = await checkRateLimit(senderId);
    if (!rate.allowed) {
      console.log('[Anu] Rate limit hit for', senderId);
      return res.status(200).json({ ok: true });
    }
  } catch (e) {}

  /* ─── Parse content ─── */
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

  /* ─── Save contact + analytics ─── */
  if (message.from) saveContact(message.from, userText).catch(() => {});
  trackAnalytics('messages').catch(() => {});

  const firstName = senderName.split(' ')[0];
  const history = await getChatHistory(chatId).catch(() => []);
  if (history.length === 0) trackAnalytics('conversations').catch(() => {});

  /* ─── Build messages ─── */
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
        {
          type: 'text',
          text: userText
            ? `Photo from "${firstName}" with caption: "${userText}". Analyze warmly.`
            : `Photo from "${firstName}". Analyze warmly.`
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${photoBase64}` }
        }
      ]
    });
  } else {
    const contextHint = history.length > 0
      ? `(Continuing conversation with "${firstName}")`
      : `(First message from "${firstName}")`;
    messages.push({
      role: 'user',
      content: `${contextHint}\nMessage: "${userText}"\n\nReply as Anu. Short, warm, matching language.`
    });
  }

  const modelToUse = (isPhoto && photoBase64) ? GROQ_VISION_MODEL : GROQ_TEXT_MODEL;

  try {
    /* ─── Typing indicator ─── */
    callAPI('sendChatAction', {
      chat_id: chatId,
      action: isPhoto ? 'upload_photo' : 'typing',
      business_connection_id: businessConnectionId
    }).catch(() => {});

    console.log('[Anu] Groq call. Model:', modelToUse, '| Photo:', isPhoto, '| History:', history.length);

    /* ─── Groq API call ─── */
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

    /* ─── Groq failed ─── */
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
          text: `⚠️ *Bot error* from ${firstName}:\n"${userText || '[photo]'}"\n\nError: ${groqRes.status}`,
          parse_mode: 'Markdown'
        }).catch(() => {});
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── Success — process reply ─── */
    const groqData = await groqRes.json();
    let reply = groqData.choices?.[0]?.message?.content?.trim() || "Hey! I'll reply soon.";
    if (reply.length > 4000) reply = reply.slice(0, 3900) + '…';

    console.log('[Anu] Reply length:', reply.length);

    /* ─── Human-like delay ─── */
    const delay = humanDelay(reply);
    console.log('[Anu] Delaying', Math.round(delay), 'ms');
    await new Promise(r => setTimeout(r, delay));

    /* ─── Send reply ─── */
    const sendResult = await callAPI('sendMessage', {
      chat_id: chatId,
      text: reply,
      business_connection_id: businessConnectionId,
      reply_to_message_id: messageId
    });

    if (sendResult && sendResult.ok) {
      console.log('[Anu] ✅ Reply delivered');
    } else {
      console.error('[Anu] ❌ Reply failed:', JSON.stringify(sendResult));
    }

    /* ─── Save history ─── */
    saveChatHistory(chatId, userText || '[photo]', reply, firstName).catch(() => {});

    /* ══════════════════════════════════════════
       ESCALATION — Smart detection
       Triggers if:
       1. User's text mentions owner/urgent/etc
       2. Bot's own reply says "I'll let Ananya know"
       3. Sentiment is angry or urgent
       ══════════════════════════════════════════ */
    const sentiment = detectSentiment(userText);
    const userEscalate = shouldEscalate(userText);
    const replyEscalate = detectEscalationFromReply(reply);
    const escalate = userEscalate || replyEscalate || sentiment === 'angry' || sentiment === 'urgent';

    console.log('[Anu] Escalation check:', {
      userEscalate,
      replyEscalate,
      sentiment,
      escalate,
      hasOwnerId: !!OWNER_CHAT_ID
    });

    if (escalate) {
      if (!OWNER_CHAT_ID) {
        console.error('[Anu] ❌ OWNER_CHAT_ID missing! Cannot notify.');
      } else {
        let emoji = '🔔';
        let label = 'Message';
        if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
        else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry sender'; }
        else if (replyEscalate) { emoji = '📩'; label = 'Forwarded'; }

        const notifyText =
          `${emoji} *${label}* from ${firstName}\n\n` +
          `💬 "${userText || '[photo]'}"\n\n` +
          `🤖 Bot replied: "${reply}"\n\n` +
          `⏰ ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

        console.log('[Anu] Sending notification to owner:', OWNER_CHAT_ID);

        const notifyResult = await callAPI('sendMessage', {
          chat_id: OWNER_CHAT_ID,
          text: notifyText,
          parse_mode: 'Markdown'
        });

        if (notifyResult && notifyResult.ok) {
          console.log('[Anu] ✅ Owner notified successfully!');
          trackAnalytics('escalations').catch(() => {});
        } else {
          console.error('[Anu] ❌ Notification FAILED:', JSON.stringify(notifyResult));
        }
      }
    }

    /* ─── Business hours notification ─── */
    if (!isBusinessHours() && OWNER_CHAT_ID) {
      await callAPI('sendMessage', {
        chat_id: OWNER_CHAT_ID,
        text: `🌙 _After-hours message from ${firstName}: "${userText || '[photo]'}"_`,
        parse_mode: 'Markdown'
      }).catch(() => {});
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
