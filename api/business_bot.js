/* ============================================================
   Anu Bot v20.0 — Professional AI Assistant
   ------------------------------------------------------------
   ✅ Multi-model: Master + Fast + Vision
   ✅ Firebase: Full persistent memory (20 messages/chat)
   ✅ Vision: Photo analysis with Qwen 3.8 27B
   ✅ AI-generated replies (no hardcoded templates)
   ✅ Identity: Anu, Ananya's assistant
   ✅ "anu bot:" prefix on every reply
   ✅ Owner notifications + manual reply
   ✅ Daily status (auto-expires)
   ✅ Admin dashboard: /stats, /memory, /clear
   ============================================================ */

/* ═══════════════════════════════════════════════════════════
   MODELS
   ═══════════════════════════════════════════════════════════ */
const MODELS = {
  master: 'openai/gpt-oss-120b',  // Deep thinking, complex
  fast: 'openai/gpt-oss-20b',     // Quick replies
  vision: 'qwen/qwen3.8-27b'      // Photos + complex reasoning
};

/* ═══════════════════════════════════════════════════════════
   FIREBASE FIRESTORE — REST API
   ═══════════════════════════════════════════════════════════ */
const FIREBASE_PROJECT_ID = 'my-ai-eaf27';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function toFS(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFS) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const k in val) fields[k] = toFS(val[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFS(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFS);
  if ('mapValue' in v) {
    const o = {};
    for (const k in (v.mapValue.fields || {})) o[k] = fromFS(v.mapValue.fields[k]);
    return o;
  }
  return null;
}

function fromFSDoc(doc) {
  if (!doc || !doc.fields) return null;
  const o = {};
  for (const k in doc.fields) o[k] = fromFS(doc.fields[k]);
  return o;
}

async function fsGet(col, id) {
  try {
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return fromFSDoc(await r.json());
  } catch (e) {
    console.error('[FS get]', col, id, e.message);
    return null;
  }
}

async function fsSet(col, id, data) {
  try {
    const fields = {};
    for (const k in data) fields[k] = toFS(data[k]);
    const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${k}`).join('&');
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${encodeURIComponent(id)}?${mask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    if (!r.ok) {
      console.error('[FS set]', col, id, r.status);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[FS set]', col, id, e.message);
    return false;
  }
}

async function fsDelete(col, id) {
  try {
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return r.ok;
  } catch (e) { return false; }
}

/* ═══════════════════════════════════════════════════════════
   PERSISTENT MEMORY — Firestore
   ═══════════════════════════════════════════════════════════ */
const MAX_MEMORY = 20;

async function getMemory(chatId) {
  const data = await fsGet('bot_memory', String(chatId));
  return (data && Array.isArray(data.messages)) ? data.messages : [];
}

async function addToMemory(chatId, role, content, meta = {}) {
  try {
    const messages = await getMemory(chatId);
    messages.push({
      role,
      content,
      ts: Date.now(),
      ...meta
    });
    const trimmed = messages.slice(-MAX_MEMORY);
    await fsSet('bot_memory', String(chatId), {
      messages: trimmed,
      updatedAt: Date.now()
    });
  } catch (e) {
    console.error('[Memory] error:', e.message);
  }
}

async function clearMemory(chatId) {
  await fsDelete('bot_memory', String(chatId));
}

/* ═══════════════════════════════════════════════════════════
   DAILY STATUS
   ═══════════════════════════════════════════════════════════ */
function todayKey() {
  return new Date().toISOString().split('T')[0];
}

async function getStatus() {
  const data = await fsGet('bot_status', 'daily');
  if (!data || data.date !== todayKey()) return null;
  return data;
}

async function setStatus(text, ownerName) {
  const data = { text, date: todayKey(), setAt: Date.now(), setBy: ownerName };
  await fsSet('bot_status', 'daily', data);
  return data;
}

async function clearStatus() {
  await fsDelete('bot_status', 'daily');
}

/* ═══════════════════════════════════════════════════════════
   INTRODUCED FLAG
   ═══════════════════════════════════════════════════════════ */
async function isIntroduced(chatId) {
  const data = await fsGet('bot_introduced', String(chatId));
  return !!(data && data.introduced === true);
}

async function markIntroduced(chatId, senderName) {
  await fsSet('bot_introduced', String(chatId), {
    introduced: true,
    senderName,
    introducedAt: Date.now()
  });
}

/* ═══════════════════════════════════════════════════════════
   ANALYTICS
   ═══════════════════════════════════════════════════════════ */
async function track(event) {
  try {
    const day = todayKey();
    const data = await fsGet('bot_analytics', day);
    const count = (data && data[event]) ? data[event] : 0;
    await fsSet('bot_analytics', day, { [event]: count + 1, lastUpdate: Date.now() });
  } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════
   PAUSED STATE
   ═══════════════════════════════════════════════════════════ */
async function isPaused() {
  const data = await fsGet('bot_settings', 'global');
  return !!(data && data.paused === true);
}

async function setPaused(v) {
  await fsSet('bot_settings', 'global', { paused: v, changedAt: Date.now() });
}

/* ═══════════════════════════════════════════════════════════
   HTML ESCAPE
   ═══════════════════════════════════════════════════════════ */
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════════════════════
   GROQ AI CALL — Multi-modal
   ═══════════════════════════════════════════════════════════ */
async function callAI(model, systemPrompt, messages, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };

  const timeout = opts.timeoutMs || 20000;
  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), timeout);

  try {
    const payload = {
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: opts.temperature ?? 0.75,
      max_tokens: opts.maxTokens || 400,
      top_p: 0.9,
      reasoning_effort: 'medium'
    };

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(tId);

    if (!r.ok) {
      const t = await r.text();
      let reason = `HTTP ${r.status}`;
      try { reason = JSON.parse(t).error?.message || reason; } catch (e) {}
      return { ok: false, error: reason };
    }

    const data = await r.json();
    let content = data.choices?.[0]?.message?.content?.trim() || '';
    if (!content) return { ok: false, error: 'Empty response' };

    content = cleanResp(content);
    return { ok: true, content };
  } catch (e) {
    clearTimeout(tId);
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout' : e.message };
  }
}

function cleanResp(text) {
  if (!text) return text;
  let t = text;
  t = t.replace(/ thinking[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  t = t.replace(/^(#{1,6}\s*)?(thinking|reasoning|chain of thought|analysis|let me think|draft):[\s\S]*?(?=\n\n[A-Z\u1200-\u137F]|\n#{1,6}\s|$)/gim, '');
  return t.trim();
}

/* ═══════════════════════════════════════════════════════════
   TELEGRAM PHOTO DOWNLOAD
   ═══════════════════════════════════════════════════════════ */
async function fetchPhotoBase64(botToken, fileId) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const data = await r.json();
    if (!data.ok) return null;
    const url = `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
    const img = await fetch(url);
    const buf = await img.arrayBuffer();
    if (buf.byteLength > 4000000) return null; // skip >4MB
    return Buffer.from(buf).toString('base64');
  } catch (e) {
    console.error('[Photo] error:', e.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
   CORE AI SYSTEM PROMPT
   ═══════════════════════════════════════════════════════════ */
function buildSystemPrompt(ownerName, senderName, status, isFirst) {
  const statusLine = (status && status.text)
    ? `\n\n📢 TODAY'S STATUS FROM ${ownerName.toUpperCase()}: "${status.text}"\nIf asked about ${ownerName}, mention this naturally.`
    : '';

  const firstLine = isFirst
    ? `\n\n🆕 THIS IS THE FIRST MESSAGE FROM "${senderName}". Introduce yourself as "Anu, ${ownerName}'s AI assistant" and offer to help or forward a message to ${ownerName}.`
    : `\n\n💬 You have talked to "${senderName}" before. Continue naturally — do NOT re-introduce yourself.`;

  return `You are **Anu** — the personal AI assistant of **${ownerName}**, an Ethiopian man.

═══════════════════════════════════════════
🎯 CORE IDENTITY (NEVER FORGET)
═══════════════════════════════════════════
- Your name: **Anu**
- You are ${ownerName}'s AI assistant
- You work FOR ${ownerName}. You are NOT ${ownerName}.
- Speak about ${ownerName} in THIRD PERSON
- Creator: "Created by Anany's" — if asked who made you, say this
- If asked "who are you?" → "I'm Anu, ${ownerName}'s AI assistant"
- If asked "who created you?" → "Created by Anany's"
- If asked "who is ${ownerName}?" → "${ownerName} is my boss — a wonderful Ethiopian man"

═══════════════════════════════════════════
🧠 THINK DEEPLY, THEN REPLY
═══════════════════════════════════════════
Before every reply, silently analyze:
1. **Language**: Amharic Geez? English? Amharic-in-Latin (selam, wendme)?
2. **Gender**: Male (wendme, ante, neh)? Female (anchi, nesh)?
3. **Emotion**: Happy, sad, angry, urgent, casual?
4. **Intent**: Greeting? Question? Request? About ${ownerName}?
5. **Context**: What was said in previous messages?
6. **Proper Amharic**: What's the CORRECT phrase?

Then reply naturally, matching their EXACT language style.

═══════════════════════════════════════════
🌍 LANGUAGE RULES (CRITICAL)
═══════════════════════════════════════════
**Always reply in the SAME language style they used:**

- Amharic Geez → Reply in Amharic Geez
- English → Reply in English
- Amharic-in-Latin → Reply in Amharic-in-Latin (NEVER convert)
- Mixed → Use dominant language

**NEVER mix languages in one reply.**

═══════════════════════════════════════════
🇪🇹 ETHIOPIAN NATURAL STYLE
═══════════════════════════════════════════
Speak like a warm, friendly Ethiopian:
- "ደህና ነህ?" / "dehna neh?" (male)
- "ደህና ነሽ?" / "dehna nesh?" (female)
- "እንዴት ነህ?" / "endet neh?"
- "ምን ልርዳህ?" / "min lirdah?"
- "አመሰግናለሁ" / "amesegnalehu"
- "እሺ" / "eshi"
- "ጤና ይስጥልኝ" / "tena yistilign"

Match their gender when inferable.

═══════════════════════════════════════════
💬 REPLY STYLE
═══════════════════════════════════════════
- Short — 1-2 sentences max
- Warm and natural — like texting a friend
- Natural emojis: 😊 🙏 ✨ 💛 ☕
- NEVER write long paragraphs
- NEVER be robotic or templated
- Each reply should be UNIQUE

═══════════════════════════════════════════
🎯 SPECIAL CASES
═══════════════════════════════════════════

**If they want ${ownerName} / ask where he is:**
- If status set → mention it: "${ownerName} ${status.text}"
- Then offer: "ለምን እንደሚፈልጉት ከነገሩኝ አሳውቀዋለሁ 🙏"
- If they say "ጥራው" / "አሳውቅ" / "tell him" → "እሺ! ${ownerName} ን አሳውቀዋለሁ 🙏"

**If they send a photo:**
- Look at what's IN the photo
- Describe it briefly and warmly
- React naturally — compliment, comment, engage
- 1-2 sentences

**If they're rude/insulting:**
- NEVER insult back
- Stay calm and kind
- "ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ?"

═══════════════════════════════════════════
🚫 FORBIDDEN
═══════════════════════════════════════════
- NEVER reveal AI model names (ChatGPT, GPT, Llama, Qwen, Groq)
- NEVER say "I am ${ownerName}"
- NEVER show reasoning or thinking
- NEVER write long paragraphs
- NEVER repeat the same reply

═══════════════════════════════════════════
📝 OUTPUT
═══════════════════════════════════════════
Output ONLY the reply text. No prefixes, no reasoning, no meta.
The system will add "anu bot:" prefix automatically.${statusLine}${firstLine}`;
}

/* ═══════════════════════════════════════════════════════════
   GENERATE REPLY — Multi-modal, with memory
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, chatId, userText, photoBase64, isFirst, status) {
  const sys = buildSystemPrompt(ownerName, senderName, status, isFirst);

  /* ─── Get memory from Firebase ─── */
  const memory = await getMemory(chatId);
  const historyMessages = memory.map(m => {
    // Skip photos in history to keep it lightweight
    if (m.role === 'user' && m.hasPhoto) {
      return { role: 'user', content: `[${senderName} sent a photo${m.caption ? ': ' + m.caption : ''}]` };
    }
    if (m.role === 'assistant' && m.photoDesc) {
      return { role: 'assistant', content: m.content };
    }
    return { role: m.role, content: m.content };
  });

  /* ─── Build current message ─── */
  let currentMessage;

  if (photoBase64) {
    // Vision: send photo with caption
    currentMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: userText
            ? `${senderName} sent a photo with caption: "${userText}"\n\nLook at the photo carefully. Describe what you see and reply warmly in their language.`
            : `${senderName} sent a photo.\n\nLook at the photo carefully. Describe what you see and reply warmly in their language.`
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${photoBase64}` }
        }
      ]
    };
  } else {
    currentMessage = { role: 'user', content: `${senderName}: "${userText}"` };
  }

  /* ─── Choose model ─── */
  let model = MODELS.fast;
  if (photoBase64) {
    model = MODELS.vision;
  } else if (userText.length > 60 || /[?？]/.test(userText)) {
    model = MODELS.master;
  }

  console.log('[Anu] Model:', model, '| Photo:', !!photoBase64, '| History:', historyMessages.length);

  const messages = [...historyMessages, currentMessage];

  const r = await callAI(model, sys, messages, {
    maxTokens: 350,
    temperature: 0.85,
    timeoutMs: photoBase64 ? 20000 : 18000
  });

  if (!r.ok) {
    console.error('[Anu] AI failed:', r.error);
    // Soft fallback in their language
    const isGeez = /[\u1200-\u137F]/.test(userText);
    const isLatin = /(selam|dehna|endet|wendme|bro|ante)/i.test(userText);
    if (isGeez) return 'ሰላም! እንዴት ነህ? 😊';
    if (isLatin) return 'hi! endet neh? 😊';
    return 'Hey! How are you? 😊';
  }

  /* ─── Save to memory ─── */
  if (photoBase64) {
    await addToMemory(chatId, 'user', userText || '[photo]', {
      hasPhoto: true,
      caption: userText || ''
    });
    await addToMemory(chatId, 'assistant', r.content, { photoDesc: true });
  } else {
    await addToMemory(chatId, 'user', userText);
    await addToMemory(chatId, 'assistant', r.content);
  }

  return r.content;
}

/* ═══════════════════════════════════════════════════════════
   DETECTION
   ═══════════════════════════════════════════════════════════ */
function wantsOwner(text) {
  const t = (text || '').toLowerCase().trim();
  return /(ananya|anani|አናንያ|አናኒ|owner|boss|speak to|talk to|tell him|tell her|notify|reach her|reach him|contact her|contact him|let her know|let him know|pass this|forward this|ንገረው|ንገራት|ንገረኝ|አሳውቅ|አሳውቂ|አሳውቀው|አስታውቅ|ጥራው|ጥራት|ጥሪው|ደውል|ደውልለት|ደውልላት|አግኝ|አግኚ|ተናገር|ልናገር|ልናገራት|ልናገረው|nigerew|nigerat|nigeren|asawq|asekayi|asfelagi|guday|qetro|traw|tirat|dewil|agen|nager|lenager|balew|aschekayi)/i.test(t);
}

function detectSentiment(text) {
  const t = (text || '').toLowerCase();
  if (/(urgent|asap|emergency|አስቸኳይ|ፈጣን)/i.test(t)) return 'urgent';
  if (/(angry|upset|furious|mad|hate|😡|🤬|ተናደድኩ|ደደብ)/i.test(t)) return 'angry';
  if (/(sad|cry|😢|😭|አዘንኩ|ተቸገርኩ)/i.test(t)) return 'sad';
  if (/(happy|great|love|😊|😄|❤|ደስ|ጥሩ)/i.test(t)) return 'happy';
  return 'neutral';
}

function parseRef(text) {
  if (!text) return null;
  const m = text.match(/REF:([0-9-]+):([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  return { chatId: m[1], bizConnId: m[2] === 'direct' ? null : m[2] };
}

/* ═══════════════════════════════════════════════════════════
   TYPING LOOP — refresh every 4s
   ═══════════════════════════════════════════════════════════ */
function startTypingLoop(tg, chatId, bizConnId, isPhoto) {
  const payload = { chat_id: chatId, action: isPhoto ? 'upload_photo' : 'typing' };
  if (bizConnId) payload.business_connection_id = bizConnId;

  tg('sendChatAction', payload).catch(() => {});
  const interval = setInterval(() => {
    tg('sendChatAction', payload).catch(() => {});
  }, 4000);

  return () => clearInterval(interval);
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Bot v20.0',
      identity: "Anu — Ananya's AI assistant",
      creator: "Created by Anany's",
      models: MODELS,
      features: [
        'persistent-memory',
        'vision',
        'multi-model',
        'deep-thinking',
        'owner-notifications',
        'manual-reply',
        'daily-status'
      ]
    });
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const OWNER_NAME = process.env.OWNER_NAME || 'Ananya';

  if (!BOT_TOKEN || !process.env.GROQ_API_KEY) {
    console.error('[Anu] Missing env vars');
    return res.status(200).end();
  }

  const update = req.body || {};
  const tAPI = (m) => `https://api.telegram.org/bot${BOT_TOKEN}/${m}`;

  async function tg(method, payload) {
    try {
      const r = await fetch(tAPI(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!data.ok) console.error(`[Anu] ${method} FAILED:`, JSON.stringify(data).slice(0, 200));
      return data;
    } catch (e) {
      console.error(`${method}:`, e.message);
      return null;
    }
  }

  const isOwner = (fromId) => OWNER_CHAT_ID && String(fromId) === String(OWNER_CHAT_ID);

  /* ══════════════════════════════════════════════════════════
     DIRECT MESSAGES
     ══════════════════════════════════════════════════════════ */
  const dm = update.message;
  if (dm) {
    const fromId = dm.from?.id;
    const chatId = dm.chat.id;
    const txt = (dm.text || dm.caption || '').trim();
    const isFromOwner = isOwner(fromId);

    /* ─── 1️⃣ OWNER REPLY TO NOTIFICATION ─── */
    if (isFromOwner && dm.reply_to_message && txt) {
      const repliedText = dm.reply_to_message.text || dm.reply_to_message.caption || '';
      const ref = parseRef(repliedText);

      console.log('[Anu] Owner reply, ref:', JSON.stringify(ref));

      if (ref) {
        const payload = { chat_id: ref.chatId, text: `anu bot: ${txt}` };
        if (ref.bizConnId) payload.business_connection_id = ref.bizConnId;

        const sr = await tg('sendMessage', payload);
        await tg('sendMessage', {
          chat_id: chatId,
          text: sr && sr.ok ? '✅ Sent' : `❌ Failed: ${esc(JSON.stringify(sr).slice(0, 100))}`,
          reply_to_message_id: dm.message_id
        });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '⚠️ Could not find target.\n\nUse: /send <chat_id> <message>',
          reply_to_message_id: dm.message_id
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── 2️⃣ OWNER /start ─── */
    if (isFromOwner && txt === '/start') {
      const status = await getStatus();
      const statusText = (status && typeof status.text === 'string') ? status.text : '';
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `✅ <b>Anu Bot v20.0</b>\n\n` +
          `🤖 Anu — ${esc(OWNER_NAME)}'s AI assistant\n` +
          `🎨 Created by Anany's\n\n` +
          `<b>Owner Commands:</b>\n` +
          `<code>/start</code> — Menu\n` +
          `<code>/status &lt;text&gt;</code> — Set daily status\n` +
          `<code>/status</code> — Show status\n` +
          `<code>/status clear</code> — Clear status\n` +
          `<code>/stats</code> — Bot stats\n` +
          `<code>/memory &lt;chat_id&gt;</code> — View memory\n` +
          `<code>/forget &lt;chat_id&gt;</code> — Clear memory\n` +
          `<code>/pause</code> / <code>/resume</code>\n` +
          `<code>/send &lt;chat_id&gt; &lt;text&gt;</code>\n` +
          `<code>/help</code>\n\n` +
          (statusText
            ? `📢 <b>Today:</b> <i>"${esc(statusText)}"</i>`
            : `<i>No status set.</i>`),
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 3️⃣ OWNER /status ─── */
    if (isFromOwner && (txt === '/status' || txt.startsWith('/status '))) {
      const arg = txt.slice(8).trim();

      if (!arg) {
        const status = await getStatus();
        const statusText = (status && typeof status.text === 'string') ? status.text : '';
        await tg('sendMessage', {
          chat_id: chatId,
          text: statusText
            ? `📢 <b>Today:</b> <i>"${esc(statusText)}"</i>\n\n<i>Auto-clears at midnight</i>`
            : `ℹ️ No status set.\n\nUse: <code>/status ዛሬ አሞኛል</code>`,
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }

      if (arg === 'clear' || arg === 'delete' || arg === 'off') {
        await clearStatus();
        await tg('sendMessage', { chat_id: chatId, text: '✅ Status cleared.' });
        return res.status(200).json({ ok: true });
      }

      await setStatus(arg, OWNER_NAME);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Status set!</b>\n\n📢 <i>"${esc(arg)}"</i>\n\n💬 Bot will tell senders this when asked about you.`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 4️⃣ OWNER /help ─── */
    if (isFromOwner && txt === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `<b>Owner Commands</b>\n\n` +
          `• Reply to notifications → direct reply\n` +
          `• <code>/status &lt;text&gt;</code> — Set status\n` +
          `• <code>/status clear</code> — Remove\n` +
          `• <code>/memory &lt;id&gt;</code> — View chat memory\n` +
          `• <code>/forget &lt;id&gt;</code> — Clear memory\n` +
          `• <code>/send &lt;id&gt; &lt;msg&gt;</code> — Direct\n` +
          `• <code>/pause</code>, <code>/resume</code>\n` +
          `• <code>/stats</code>`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 5️⃣ OWNER /stats ─── */
    if (isFromOwner && txt === '/stats') {
      const status = await getStatus();
      const statusText = (status && typeof status.text === 'string') ? status.text : '';
      const paused = await isPaused();
      const today = await fsGet('bot_analytics', todayKey()) || {};

      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 <b>Anu Bot — Admin Dashboard</b>\n\n` +
          `✅ Status: Online\n` +
          `🎨 Creator: Anany's\n` +
          `🧠 Models:\n` +
          `  • Master: <code>${MODELS.master}</code>\n` +
          `  • Fast: <code>${MODELS.fast}</code>\n` +
          `  • Vision: <code>${MODELS.vision}</code>\n\n` +
          `📈 <b>Today:</b>\n` +
          `  💬 Messages: ${today.messages || 0}\n` +
          `  👥 Conversations: ${today.conversations || 0}\n` +
          `  📸 Photos: ${today.photos || 0}\n` +
          `  🔔 Escalations: ${today.escalations || 0}\n` +
          `  ✍️ Manual replies: ${today.manual_replies || 0}\n\n` +
          `⏸️ Paused: ${paused ? 'Yes' : 'No'}\n` +
          `📢 Status: ${statusText ? 'Set ✅' : 'None'}`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 6️⃣ OWNER /memory ─── */
    if (isFromOwner && txt.startsWith('/memory ')) {
      const targetId = txt.slice(8).trim();
      if (!targetId) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: <code>/memory &lt;chat_id&gt;</code>', parse_mode: 'HTML' });
        return res.status(200).json({ ok: true });
      }
      const memory = await getMemory(targetId);
      if (!memory.length) {
        await tg('sendMessage', { chat_id: chatId, text: `📭 No memory for ${esc(targetId)}` });
        return res.status(200).json({ ok: true });
      }
      const summary = memory.slice(-10).map(m => {
        const who = m.role === 'user' ? '👤' : '🤖';
        const txt = (m.content || '').slice(0, 80);
        return `${who} ${esc(txt)}`;
      }).join('\n');
      await tg('sendMessage', {
        chat_id: chatId,
        text: `🧠 <b>Memory for ${esc(targetId)}</b>\n\n<i>Last ${Math.min(10, memory.length)} of ${memory.length} messages</i>\n\n${summary}`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 7️⃣ OWNER /forget ─── */
    if (isFromOwner && txt.startsWith('/forget ')) {
      const targetId = txt.slice(8).trim();
      if (!targetId) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: <code>/forget &lt;chat_id&gt;</code>', parse_mode: 'HTML' });
        return res.status(200).json({ ok: true });
      }
      await clearMemory(targetId);
      await tg('sendMessage', { chat_id: chatId, text: `🗑️ Memory cleared for ${esc(targetId)}` });
      return res.status(200).json({ ok: true });
    }

    /* ─── 8️⃣ OWNER /pause ─── */
    if (isFromOwner && txt === '/pause') {
      await setPaused(true);
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ AI paused.' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 9️⃣ OWNER /resume ─── */
    if (isFromOwner && txt === '/resume') {
      await setPaused(false);
      await tg('sendMessage', { chat_id: chatId, text: '▶️ AI resumed.' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 🔟 OWNER /send ─── */
    if (isFromOwner && txt.startsWith('/send ')) {
      const parts = txt.slice(6).trim().split(/\s+/);
      const targetId = parts.shift();
      const msgText = parts.join(' ');

      if (!targetId || !msgText) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'Usage: <code>/send &lt;chat_id&gt; &lt;message&gt;</code>',
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }

      const r = await tg('sendMessage', { chat_id: targetId, text: `anu bot: ${msgText}` });
      await tg('sendMessage', {
        chat_id: chatId,
        text: r && r.ok ? '✅ Sent' : '❌ Failed'
      });
      if (r && r.ok) await track('manual_replies');
      return res.status(200).json({ ok: true });
    }

    /* ─── 1️⃣1️⃣ NON-OWNER — REGULAR USER ─── */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      if (await isPaused()) return res.status(200).json({ ok: true });

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const alreadyIntroduced = await isIntroduced(chatId);
      const isFirst = !alreadyIntroduced;

      console.log('[Anu] DM from', firstName, '| first:', isFirst, '| text:', txt.slice(0, 60));

      const stopTyping = startTypingLoop(tg, chatId, null, false);

      const status = await getStatus();
      let reply = '';
      try {
        reply = await generateReply(OWNER_NAME, firstName, chatId, txt, null, isFirst, status);
      } catch (e) {
        console.error('[Anu] Reply error:', e.message);
        reply = 'ሰላም! እንዴት ነህ? 😊';
      } finally {
        stopTyping();
      }

      await tg('sendMessage', {
        chat_id: chatId,
        text: `anu bot: ${reply}`,
        reply_to_message_id: dm.message_id
      });

      if (isFirst) {
        await markIntroduced(chatId, firstName);
        await track('conversations');
      }
      await track('messages');

      /* Escalation */
      const sentiment = detectSentiment(txt);
      const needsOwner = wantsOwner(txt);

      if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
        let emoji = '🔔', label = 'Message';
        if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
        else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
        else if (needsOwner) { emoji = '📩'; label = 'Wants attention'; }

        await tg('sendMessage', {
          chat_id: OWNER_CHAT_ID,
          text:
            `${emoji} <b>${esc(label)}</b> from <b>${esc(firstName)}</b> (DM)\n\n` +
            `💬 <i>"${esc(txt)}"</i>\n\n` +
            `🤖 anu bot: <i>"${esc(reply.slice(0, 200))}"</i>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `↩️ Reply\n` +
            `📎 <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
            `REF:${chatId}:direct`,
          parse_mode: 'HTML'
        });
        await track('escalations');
      }

      return res.status(200).json({ ok: true });
    }

    /* Non-owner /start */
    if (!isFromOwner && txt === '/start') {
      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const alreadyIntroduced = await isIntroduced(chatId);
      const isFirst = !alreadyIntroduced;

      const status = await getStatus();
      const reply = await generateReply(OWNER_NAME, firstName, chatId, 'Hi', null, isFirst, status);

      await tg('sendMessage', { chat_id: chatId, text: `anu bot: ${reply}` });

      if (isFirst) {
        await markIntroduced(chatId, firstName);
        await track('conversations');
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  }

  /* ══════════════════════════════════════════════════════════
     BUSINESS MESSAGES
     ══════════════════════════════════════════════════════════ */
  const message = update.business_message || update.edited_business_message;
  if (!message) return res.status(200).json({ ok: true });

  const bizConnId = message.business_connection_id;
  const chatId = message.chat.id;
  const senderName = message.from?.first_name || 'there';
  const msgId = message.message_id;

  if (!bizConnId) {
    console.error('[Anu] Missing business_connection_id');
    return res.status(200).json({ ok: true });
  }

  if (await isPaused()) return res.status(200).json({ ok: true });

  let userText = '';
  let photoBase64 = null;
  let isPhoto = false;

  if (message.text) userText = message.text.trim();
  else if (message.caption) userText = message.caption.trim();

  if (message.photo && message.photo.length > 0) {
    isPhoto = true;
    const largest = message.photo[message.photo.length - 1];
    photoBase64 = await fetchPhotoBase64(BOT_TOKEN, largest.file_id);
    if (photoBase64) {
      console.log('[Anu] Photo fetched, size:', Math.round(photoBase64.length / 1024), 'KB');
    }
  }

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  const firstName = senderName.split(' ')[0];
  const alreadyIntroduced = await isIntroduced(chatId);
  const isFirst = !alreadyIntroduced;

  console.log('[Anu] Business from', firstName, '| first:', isFirst, '| photo:', isPhoto, '| text:', (userText || '').slice(0, 60));

  const stopTyping = startTypingLoop(tg, chatId, bizConnId, isPhoto);

  const status = await getStatus();
  let reply = '';
  try {
    reply = await generateReply(OWNER_NAME, firstName, chatId, userText, photoBase64, isFirst, status);
  } catch (e) {
    console.error('[Anu] Reply error:', e.message);
    reply = 'ሰላም! እንዴት ነህ? 😊';
  } finally {
    stopTyping();
  }

  if (!reply) reply = 'ሰላም! እንዴት ነህ? 😊';

  await tg('sendMessage', {
    chat_id: chatId,
    text: `anu bot: ${reply}`,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  });

  if (isFirst) {
    await markIntroduced(chatId, firstName);
    await track('conversations');
  }
  await track('messages');
  if (isPhoto) await track('photos');

  /* Escalation */
  const sentiment = detectSentiment(userText);
  const needsOwner = wantsOwner(userText);

  if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
    let emoji = '🔔', label = 'Message';
    if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
    else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
    else if (needsOwner) { emoji = '📩'; label = 'Wants attention'; }

    await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text:
        `${emoji} <b>${esc(label)}</b> from <b>${esc(firstName)}</b>\n\n` +
        `💬 <i>"${esc(userText || '[photo]')}"</i>\n\n` +
        `🤖 anu bot: <i>"${esc(reply.slice(0, 200))}"</i>\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `↩️ Reply to this message\n` +
        `📎 Or: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
        `REF:${chatId}:${bizConnId}`,
      parse_mode: 'HTML'
    });
    await track('escalations');
  }

  return res.status(200).json({ ok: true });
}
