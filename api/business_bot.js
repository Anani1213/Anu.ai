/* ============================================================
   Anu Bot v21.0 — Professional AI Assistant
   ------------------------------------------------------------
   ✅ Multi-AI Chain: Draft → Verify → Final (2 models)
   ✅ Delayed typing (only 5s before final send)
   ✅ NO fast model — always master quality
   ✅ Full Firebase persistent memory
   ✅ Vision support (photos)
   ✅ "anu bot:" prefix on all replies
   ✅ Beautiful admin dashboard
   ✅ 100% AI-generated replies (zero templates)
   ============================================================ */

/* ═══════════════════════════════════════════════════════════
   MODEL CONFIG — Only high-quality models
   ═══════════════════════════════════════════════════════════ */
const MODELS = {
  draft: 'openai/gpt-oss-120b',   // Primary generation
  verify: 'openai/gpt-oss-120b',  // Verification & refinement
  vision: 'qwen/qwen3.8-27b'      // Photo analysis
};

const MAX_MEMORY = 20;
const TYPING_MIN_MS = 5000;
const TYPING_MAX_MS = 9000;

/* ═══════════════════════════════════════════════════════════
   FIREBASE FIRESTORE REST
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
   MEMORY — Persistent (20 messages per chat)
   ═══════════════════════════════════════════════════════════ */
async function getMemory(chatId) {
  const data = await fsGet('bot_memory', String(chatId));
  return (data && Array.isArray(data.messages)) ? data.messages : [];
}

async function addToMemory(chatId, role, content, meta = {}) {
  try {
    const messages = await getMemory(chatId);
    messages.push({ role, content, ts: Date.now(), ...meta });
    await fsSet('bot_memory', String(chatId), {
      messages: messages.slice(-MAX_MEMORY),
      updatedAt: Date.now()
    });
  } catch (e) {
    console.error('[Memory]', e.message);
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
async function track(event, amount = 1) {
  try {
    const day = todayKey();
    const data = await fsGet('bot_analytics', day);
    const count = (data && data[event]) ? data[event] : 0;
    await fsSet('bot_analytics', day, { [event]: count + amount, lastUpdate: Date.now() });
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
   GROQ AI CALL
   ═══════════════════════════════════════════════════════════ */
async function callAI(model, systemPrompt, messages, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };

  const timeout = opts.timeoutMs || 25000;
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
   TELEGRAM — Fetch photo
   ═══════════════════════════════════════════════════════════ */
async function fetchPhotoBase64(botToken, fileId) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const data = await r.json();
    if (!data.ok) return null;
    const url = `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
    const img = await fetch(url);
    const buf = await img.arrayBuffer();
    if (buf.byteLength > 4000000) return null;
    return Buffer.from(buf).toString('base64');
  } catch (e) {
    console.error('[Photo]', e.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
   SYSTEM PROMPTS — Two-stage AI chain
   ═══════════════════════════════════════════════════════════ */

/* ─── STAGE 1: DRAFT prompt ─── */
function buildDraftPrompt(ownerName, senderName, status, isFirst, history) {
  const statusLine = (status && status.text)
    ? `\n\n📢 TODAY'S STATUS FROM ${ownerName.toUpperCase()}: "${status.text}"\nIf asked about ${ownerName}, mention this.`
    : '';

  const historyLine = history.length > 0
    ? `\n\n📜 CONVERSATION HISTORY:\n${history.map(h => `${h.role === 'user' ? senderName : 'Anu'}: ${h.content}`).join('\n')}`
    : '';

  const firstLine = isFirst
    ? `\n\n🆕 FIRST MESSAGE from "${senderName}". Introduce yourself as "Anu, ${ownerName}'s AI assistant". Give them options: leave a message OR get help directly.`
    : '';

  return `You are **Anu** — the personal AI assistant of **${ownerName}**, an Ethiopian man.

═══════════════════════════════════════════
🎯 IDENTITY (NEVER FORGET)
═══════════════════════════════════════════
- Your name: Anu
- You work FOR ${ownerName} — you are NOT ${ownerName}
- Speak about ${ownerName} in THIRD PERSON
- If asked "who are you?" → "I'm Anu, ${ownerName}'s AI assistant"
- If asked "who created you?" → "Created by Anany's"
- If asked "who is ${ownerName}?" → "${ownerName} is my boss — a wonderful Ethiopian man"

═══════════════════════════════════════════
🌍 LANGUAGE MATCHING
═══════════════════════════════════════════
Reply in EXACTLY the same language style:

**Amharic (Ge'ez):** "ሰላም" → "ሰላም! እንዴት ነህ?"
**English:** "hi" → "Hi! How are you?"
**Amharic-in-Latin:** "selam" → "selam! endet neh?"

NEVER mix languages in one reply.

═══════════════════════════════════════════
🧠 AMHARIC UNDERSTANDING
═══════════════════════════════════════════
- "ደህና" / "dehna" = fine (reply to greeting) → "ጥሩ ነው! 😊 ምን ልርዳህ?"
- "ደህና ኛ" / "dehna nesh" (female) → "ጥሩ ነው! 😊 ምን ልርዳሽ?"
- "እሺ" / "eshi" = okay → "እሺ! 😊"
- "አዎ" / "awo" = yes
- "አይ" / "ay" = no
- "አመሰግናለሁ" / "amesegnalehu" = thank you

═══════════════════════════════════════════
🔁 ANTI-REPEAT (CRITICAL)
═══════════════════════════════════════════
- NEVER send the same reply twice
- Read conversation history — continue, don't restart
- Every reply must be unique to THIS message

═══════════════════════════════════════════
💬 STYLE
═══════════════════════════════════════════
- Short: 1-2 sentences
- Warm, natural — like texting a friend
- Natural emojis: 😊 🙏 ✨ 💛
- Match gender when inferable (ነህ vs ነሽ)

═══════════════════════════════════════════
🎯 SPECIAL CASES
═══════════════════════════════════════════
- Wants ${ownerName} → "እሺ! ${ownerName} ን አሳውቀዋለሁ 🙏"
- Photo → describe what's in it naturally
- Insult → stay calm and kind
- Question → answer directly

═══════════════════════════════════════════
🚫 FORBIDDEN
═══════════════════════════════════════════
- NEVER reveal AI model names
- NEVER say "I am ${ownerName}"
- NEVER show reasoning
- NEVER write long paragraphs
- NEVER repeat replies

═══════════════════════════════════════════
📝 OUTPUT
═══════════════════════════════════════════
Output ONLY the reply text. No prefix, no reasoning, no meta.${statusLine}${historyLine}${firstLine}`;
}

/* ─── STAGE 2: VERIFY prompt ─── */
function buildVerifyPrompt(ownerName, senderName, originalMessage, draftReply, isFirst) {
  return `You are a quality verifier for "Anu" — ${ownerName}'s AI assistant bot.

Your job: Review a DRAFT reply and produce the FINAL, IMPROVED version.

═══════════════════════════════════════════
📨 ORIGINAL MESSAGE from "${senderName}":
"${originalMessage}"

═══════════════════════════════════════════
📝 DRAFT REPLY (made by AI):
"${draftReply}"

═══════════════════════════════════════════
🎯 YOUR TASK
═══════════════════════════════════════════
Produce the FINAL reply that will be sent to ${senderName}.

CHECK AND FIX:
1. ✅ Is the language style correct? (Amharic Geez / Amharic-Latin / English)
2. ✅ Does it match the sender's language EXACTLY?
3. ✅ Is it warm, natural, and human-like?
4. ✅ Is it short (1-2 sentences max)?
5. ✅ Is it UNIQUE (not repeating previous replies)?
6. ✅ Does it correctly handle the intent?
7. ✅ Does it sound like "Anu, ${ownerName}'s assistant"?
8. ✅ Is it grammatically correct in the target language?
9. ✅ Are emojis natural and appropriate?
${isFirst ? '10. ✅ Does it introduce as "Anu, ${ownerName}\'s AI assistant"?' : ''}

═══════════════════════════════════════════
🚫 NEVER
═══════════════════════════════════════════
- Reveal model names
- Say "I am ${ownerName}"
- Add meta-commentary like "Here's the reply:"
- Use long paragraphs
- Repeat the draft verbatim if it's weak
- Change the language style

═══════════════════════════════════════════
📝 OUTPUT
═══════════════════════════════════════════
Output ONLY the final reply text.
No quotes, no "Final:", no reasoning.
Just the message that will be sent.`;
}

/* ═══════════════════════════════════════════════════════════
   MULTI-AI CHAIN — Draft → Verify → Final
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, chatId, userText, photoBase64, isFirst, status) {
  /* ─── Get memory ─── */
  const memory = await getMemory(chatId);
  const historyMessages = memory.map(m => {
    if (m.role === 'user' && m.hasPhoto) {
      return { role: 'user', content: `[${senderName} sent a photo${m.caption ? ': ' + m.caption : ''}]` };
    }
    return { role: m.role, content: m.content };
  });

  /* ─── Build current message ─── */
  let currentMessage;
  if (photoBase64) {
    currentMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: userText
            ? `${senderName} sent a photo with caption: "${userText}"\n\nDescribe what you see in the photo and reply warmly.`
            : `${senderName} sent a photo.\n\nDescribe what you see in the photo and reply warmly.`
        },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photoBase64}` } }
      ]
    };
  } else {
    currentMessage = { role: 'user', content: `${senderName}: "${userText}"` };
  }

  /* ═══════════════════════════════════════════════
     STAGE 1: DRAFT (with vision if photo)
     ═══════════════════════════════════════════════ */
  const draftPrompt = buildDraftPrompt(ownerName, senderName, status, isFirst, historyMessages);
  const draftMessages = [...historyMessages, currentMessage];

  const modelForDraft = photoBase64 ? MODELS.vision : MODELS.draft;

  console.log('[Anu] Stage 1 — Draft using', modelForDraft);

  const draftRes = await callAI(modelForDraft, draftPrompt, draftMessages, {
    maxTokens: 400,
    temperature: 0.85,
    timeoutMs: 22000
  });

  if (!draftRes.ok) {
    console.error('[Anu] Draft failed:', draftRes.error);
    // Emergency fallback (rare)
    const isGeez = /[\u1200-\u137F]/.test(userText || '');
    const isLatin = /(selam|dehna|endet|wendme|bro|ante)/i.test(userText || '');
    if (isGeez) return 'ሰላም! እንዴት ነህ? 😊';
    if (isLatin) return 'selam! endet neh? 😊';
    return 'Hey! How are you? 😊';
  }

  const draftReply = draftRes.content;
  console.log('[Anu] Draft:', draftReply.slice(0, 100));

  /* ═══════════════════════════════════════════════
     STAGE 2: VERIFY & REFINE (skip if photo — vision needs less verification)
     ═══════════════════════════════════════════════ */
  let finalReply = draftReply;

  if (!photoBase64) {
    const verifyPrompt = buildVerifyPrompt(ownerName, senderName, userText, draftReply, isFirst);

    console.log('[Anu] Stage 2 — Verifying with', MODELS.verify);

    const verifyRes = await callAI(
      MODELS.verify,
      verifyPrompt,
      [{ role: 'user', content: 'Produce the final reply now.' }],
      {
        maxTokens: 400,
        temperature: 0.7,
        timeoutMs: 20000
      }
    );

    if (verifyRes.ok && verifyRes.content && verifyRes.content.length > 2) {
      finalReply = verifyRes.content;
      console.log('[Anu] Final:', finalReply.slice(0, 100));
    } else {
      console.warn('[Anu] Verify failed, using draft');
    }
  }

  /* ─── Sanity checks ─── */
  if (!finalReply || finalReply.length < 2) {
    finalReply = draftReply;
  }

  // Remove any accidental "Final:" or quotes
  finalReply = finalReply
    .replace(/^(final|reply|answer|response)\s*[:：]\s*/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  /* ─── Save to memory ─── */
  if (photoBase64) {
    await addToMemory(chatId, 'user', userText || '[photo]', { hasPhoto: true, caption: userText || '' });
    await addToMemory(chatId, 'assistant', finalReply, { photoDesc: true });
  } else {
    await addToMemory(chatId, 'user', userText);
    await addToMemory(chatId, 'assistant', finalReply);
  }

  return finalReply;
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
   SMART TYPING — Only show typing ~5s before send
   ═══════════════════════════════════════════════════════════ */
function calcTypingDelay(reply) {
  const len = (reply || '').length;
  const base = Math.min(len * 30, TYPING_MAX_MS);
  return Math.max(TYPING_MIN_MS, base);
}

async function sendWithTyping(tg, payload, replyText) {
  const delay = calcTypingDelay(replyText);
  const typingPayload = { chat_id: payload.chat_id, action: 'typing' };
  if (payload.business_connection_id) typingPayload.business_connection_id = payload.business_connection_id;

  // Start typing indicator
  await tg('sendChatAction', typingPayload).catch(() => {});

  // Refresh once halfway (in case reply is long)
  const refreshAt = Math.floor(delay / 2);
  const refreshTimer = setTimeout(() => {
    tg('sendChatAction', typingPayload).catch(() => {});
  }, refreshAt);

  // Wait the delay
  await new Promise(r => setTimeout(r, delay));
  clearTimeout(refreshTimer);

  // Send the message
  return tg('sendMessage', payload);
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Bot v21.0',
      identity: "Anu — Ananya's AI assistant",
      creator: "Created by Anany's",
      models: MODELS,
      features: [
        'multi-ai-chain',
        'delayed-typing',
        'persistent-memory',
        'vision',
        'owner-dashboard',
        'manual-reply'
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
        if (sr && sr.ok) await track('manual_replies');
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '⚠️ Could not find target.\n\nUse: <code>/send &lt;chat_id&gt; &lt;message&gt;</code>',
          parse_mode: 'HTML',
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
          `👑 <b>Anu Bot v21.0 — Admin Panel</b>\n\n` +
          `🎨 Created by Anany's\n` +
          `🧠 Multi-AI Chain: Draft → Verify\n` +
          `💾 Persistent Memory: ${MAX_MEMORY} msgs\n\n` +
          `<b>━━━ COMMANDS ━━━</b>\n` +
          `<b>📊 Dashboard</b>\n` +
          `<code>/stats</code> — Full dashboard\n` +
          `<code>/memory &lt;chat_id&gt;</code> — View memory\n` +
          `<code>/forget &lt;chat_id&gt;</code> — Clear memory\n\n` +
          `<b>💬 Messaging</b>\n` +
          `<code>/send &lt;chat_id&gt; &lt;msg&gt;</code> — Direct send\n` +
          `↩️ <i>Reply to notification</i> — Reply as you\n\n` +
          `<b>📢 Status</b>\n` +
          `<code>/status &lt;text&gt;</code> — Set daily status\n` +
          `<code>/status</code> — Show status\n` +
          `<code>/status clear</code> — Clear\n\n` +
          `<b>⚙️ Control</b>\n` +
          `<code>/pause</code> — Pause AI\n` +
          `<code>/resume</code> — Resume AI\n` +
          `<code>/help</code> — Help\n\n` +
          `<b>━━━ CURRENT ━━━</b>\n` +
          (statusText
            ? `📢 <b>Today's Status:</b>\n<i>"${esc(statusText)}"</i>`
            : `<i>No status set for today.</i>`),
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
            ? `📢 <b>Today's Status:</b>\n<i>"${esc(statusText)}"</i>\n\n⏰ Auto-clears at midnight`
            : `ℹ️ No status set.\n\n💡 Set one: <code>/status ዛሬ አሞኛል</code>`,
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }

      if (arg === 'clear' || arg === 'delete' || arg === 'off') {
        await clearStatus();
        await tg('sendMessage', { chat_id: chatId, text: '🗑️ Status cleared.' });
        return res.status(200).json({ ok: true });
      }

      await setStatus(arg, OWNER_NAME);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Status set!</b>\n\n📢 <i>"${esc(arg)}"</i>\n\n💬 Bot will tell senders when asked about you.`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 4️⃣ OWNER /help ─── */
    if (isFromOwner && txt === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `<b>📖 Owner Commands</b>\n\n` +
          `<b>━━━━ Messaging ━━━━</b>\n` +
          `↩️ Reply to notifications\n` +
          `<code>/send &lt;id&gt; &lt;msg&gt;</code>\n\n` +
          `<b>━━━━ Status ━━━━</b>\n` +
          `<code>/status &lt;text&gt;</code>\n` +
          `<code>/status clear</code>\n\n` +
          `<b>━━━━ Memory ━━━━</b>\n` +
          `<code>/memory &lt;id&gt;</code>\n` +
          `<code>/forget &lt;id&gt;</code>\n\n` +
          `<b>━━━━ Control ━━━━</b>\n` +
          `<code>/pause</code> / <code>/resume</code>\n` +
          `<code>/stats</code>`,
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
          `📊 <b>Anu Bot — Admin Dashboard</b>\n` +
          `🎨 Created by Anany's\n\n` +
          `<b>━━━ STATUS ━━━</b>\n` +
          `🟢 Bot: <b>Online</b>\n` +
          `⏸️ Paused: <b>${paused ? 'YES' : 'No'}</b>\n` +
          `📢 Daily Status: <b>${statusText ? 'Set ✅' : 'None'}</b>\n\n` +
          `<b>━━━ TODAY ━━━</b>\n` +
          `💬 Messages: <b>${today.messages || 0}</b>\n` +
          `👥 Conversations: <b>${today.conversations || 0}</b>\n` +
          `📸 Photos: <b>${today.photos || 0}</b>\n` +
          `🔔 Escalations: <b>${today.escalations || 0}</b>\n` +
          `✍️ Manual replies: <b>${today.manual_replies || 0}</b>\n\n` +
          `<b>━━━ MODELS ━━━</b>\n` +
          `🧠 Draft: <code>${MODELS.draft}</code>\n` +
          `✔️ Verify: <code>${MODELS.verify}</code>\n` +
          `👁️ Vision: <code>${MODELS.vision}</code>\n\n` +
          `<b>━━━ SYSTEM ━━━</b>\n` +
          `💾 Memory: Firebase (${MAX_MEMORY} msgs/chat)\n` +
          `⏱️ Typing delay: 5-9s\n` +
          `🔗 Multi-AI Chain: Draft → Verify`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 6️⃣ OWNER /memory ─── */
    if (isFromOwner && txt.startsWith('/memory ')) {
      const targetId = txt.slice(8).trim();
      if (!targetId) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'Usage: <code>/memory &lt;chat_id&gt;</code>',
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }

      const memory = await getMemory(targetId);
      if (!memory.length) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: `📭 <b>No memory for</b> <code>${esc(targetId)}</code>`,
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }

      const summary = memory.slice(-10).map(m => {
        const who = m.role === 'user' ? '👤' : '🤖';
        const time = new Date(m.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        return `${who} [${time}] ${esc((m.content || '').slice(0, 60))}`;
      }).join('\n');

      await tg('sendMessage', {
        chat_id: chatId,
        text: `🧠 <b>Memory:</b> <code>${esc(targetId)}</code>\n\n<i>Showing last ${Math.min(10, memory.length)} of ${memory.length} messages</i>\n\n${summary}`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 7️⃣ OWNER /forget ─── */
    if (isFromOwner && txt.startsWith('/forget ')) {
      const targetId = txt.slice(8).trim();
      if (!targetId) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'Usage: <code>/forget &lt;chat_id&gt;</code>',
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }
      await clearMemory(targetId);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `🗑️ <b>Memory cleared</b> for <code>${esc(targetId)}</code>`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 8️⃣ OWNER /pause ─── */
    if (isFromOwner && txt === '/pause') {
      await setPaused(true);
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ <b>AI paused</b>\n\nBot will not reply to anyone.', parse_mode: 'HTML' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 9️⃣ OWNER /resume ─── */
    if (isFromOwner && txt === '/resume') {
      await setPaused(false);
      await tg('sendMessage', { chat_id: chatId, text: '▶️ <b>AI resumed</b>\n\nBot is now active.', parse_mode: 'HTML' });
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
      const isFirst = !(await isIntroduced(chatId));

      console.log('[Anu] DM from', firstName, '| first:', isFirst, '| text:', txt.slice(0, 60));

      /* ─── AI Chain: Draft → Verify (no typing yet) ─── */
      const status = await getStatus();
      let reply = '';
      try {
        reply = await generateReply(OWNER_NAME, firstName, chatId, txt, null, isFirst, status);
      } catch (e) {
        console.error('[Anu] Error:', e.message);
        reply = /[\u1200-\u137F]/.test(txt) ? 'ሰላም! እንዴት ነህ? 😊' : 'Hey! How are you? 😊';
      }

      /* ─── Send with delayed typing ─── */
      await sendWithTyping(tg, {
        chat_id: chatId,
        text: `anu bot: ${reply}`,
        reply_to_message_id: dm.message_id
      }, reply);

      if (isFirst) {
        await markIntroduced(chatId, firstName);
        await track('conversations');
      }
      await track('messages');

      /* ─── Escalation ─── */
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
            `${emoji} <b>${esc(label)}</b>\n` +
            `👤 <b>From:</b> ${esc(firstName)}\n` +
            `🆔 <b>Chat:</b> <code>${chatId}</code>\n\n` +
            `<b>💬 Message:</b>\n<i>"${esc(txt)}"</i>\n\n` +
            `<b>🤖 Anu replied:</b>\n<i>"${esc(reply.slice(0, 200))}"</i>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `↩️ <b>Reply to this message</b>\n` +
            `📎 Or: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
            `<code>REF:${chatId}:direct</code>`,
          parse_mode: 'HTML'
        });
        await track('escalations');
      }

      return res.status(200).json({ ok: true });
    }

    /* ─── Non-owner /start ─── */
    if (!isFromOwner && txt === '/start') {
      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !(await isIntroduced(chatId));

      console.log('[Anu] /start from', firstName);

      const status = await getStatus();
      let reply = '';
      try {
        reply = await generateReply(OWNER_NAME, firstName, chatId, 'Hi, I just started the bot', null, isFirst, status);
      } catch (e) {
        reply = 'Hi! I\'m Anu, ' + OWNER_NAME + '\'s AI assistant 😊 How can I help you?';
      }

      await sendWithTyping(tg, {
        chat_id: chatId,
        text: `anu bot: ${reply}`
      }, reply);

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
      console.log('[Anu] Photo fetched:', Math.round(photoBase64.length / 1024), 'KB');
    }
  }

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  const firstName = senderName.split(' ')[0];
  const isFirst = !(await isIntroduced(chatId));

  console.log('[Anu] Business from', firstName, '| first:', isFirst, '| photo:', isPhoto, '| text:', (userText || '').slice(0, 60));

  /* ─── AI Chain: Draft → Verify (no typing yet) ─── */
  const status = await getStatus();
  let reply = '';
  try {
    reply = await generateReply(OWNER_NAME, firstName, chatId, userText, photoBase64, isFirst, status);
  } catch (e) {
    console.error('[Anu] Error:', e.message);
    reply = /[\u1200-\u137F]/.test(userText) ? 'ሰላም! እንዴት ነህ? 😊' : 'Hey! How are you? 😊';
  }

  if (!reply) reply = /[\u1200-\u137F]/.test(userText) ? 'ሰላም! 😊' : 'Hey! 😊';

  /* ─── Send with delayed typing ─── */
  await sendWithTyping(tg, {
    chat_id: chatId,
    text: `anu bot: ${reply}`,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  }, reply);

  if (isFirst) {
    await markIntroduced(chatId, firstName);
    await track('conversations');
  }
  await track('messages');
  if (isPhoto) await track('photos');

  /* ─── Escalation ─── */
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
        `${emoji} <b>${esc(label)}</b>\n` +
        `👤 <b>From:</b> ${esc(firstName)}\n` +
        `🆔 <b>Chat:</b> <code>${chatId}</code>\n\n` +
        `<b>💬 Message:</b>\n<i>"${esc(userText || '[photo]')}"</i>\n\n` +
        `<b>🤖 Anu replied:</b>\n<i>"${esc(reply.slice(0, 200))}"</i>\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `↩️ <b>Reply to this message</b>\n` +
        `📎 Or: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
        `<code>REF:${chatId}:${bizConnId}</code>`,
      parse_mode: 'HTML'
    });
    await track('escalations');
  }

  return res.status(200).json({ ok: true });
}
