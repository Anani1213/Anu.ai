/* ============================================================
   Anu Bot v17.1 — Final Fixed Version
   ------------------------------------------------------------
   ✅ Fixed: null status crash
   ✅ Fixed: typing indicator staying too long
   ✅ Faster AI responses (15s max)
   ✅ "anu bot:" prefix on every reply
   ✅ Firebase status persistence
   ✅ Deep thinking without being slow
   ============================================================ */

const SMART_MODEL = 'openai/gpt-oss-120b';

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
    console.error('[FS] get error:', e.message);
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
    return r.ok;
  } catch (e) {
    console.error('[FS] set error:', e.message);
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
   STATUS
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
  const data = {
    text,
    date: todayKey(),
    setAt: Date.now(),
    setBy: ownerName || 'owner'
  };
  await fsSet('bot_status', 'daily', data);
  return data;
}

async function clearStatus() {
  await fsDelete('bot_status', 'daily');
}

/* ═══════════════════════════════════════════════════════════
   IN-MEMORY STATE
   ═══════════════════════════════════════════════════════════ */
const state = {
  paused: false,
  introduced: new Set(),
  history: new Map()
};

function getHist(chatId) {
  return state.history.get(String(chatId)) || [];
}

function addHist(chatId, role, content) {
  const k = String(chatId);
  const h = state.history.get(k) || [];
  h.push({ role, content });
  state.history.set(k, h.slice(-12));
  if (state.history.size > 200) {
    const keys = [...state.history.keys()].slice(0, 100);
    keys.forEach(x => state.history.delete(x));
  }
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
   GROQ AI — Faster responses
   ═══════════════════════════════════════════════════════════ */
async function callAI(sysPrompt, messages, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };

  const timeout = opts.timeoutMs || 12000; // 12s max — faster than 25s
  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), timeout);

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: SMART_MODEL,
        messages: [{ role: 'system', content: sysPrompt }, ...messages],
        temperature: opts.temperature ?? 0.75,
        max_tokens: opts.maxTokens || 300,
        top_p: 0.9,
        reasoning_effort: 'low' // FAST but still smart
      }),
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
    if (!content) return { ok: false, error: 'Empty' };

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
  t = t.replace(/^(#{1,6}\s*)?(thinking|reasoning|chain of thought|analysis|my thought process|let me think|draft|tone|language):[\s\S]*?(?=\n\n[A-Z\u1200-\u137F]|\n#{1,6}\s|$)/gim, '');
  const draftMatch = t.match(/draft:\s*"([^"]+)"/i);
  if (draftMatch && t.length < 400) t = draftMatch[1];
  return t.trim();
}

/* ═══════════════════════════════════════════════════════════
   SYSTEM PROMPT — Null-safe
   ═══════════════════════════════════════════════════════════ */
function sysPrompt(ownerName, senderName, status) {
  const statusText = (status && typeof status.text === 'string') ? status.text.trim() : '';

  const statusBlock = statusText
    ? `

═══════════════════════════════════════════
📢 TODAY'S STATUS (${ownerName.toUpperCase()})
═══════════════════════════════════════════
"${statusText}"

If anyone asks where ${ownerName} is or about him, tell them this naturally.`
    : '';

  return `You are **Anu** — ${ownerName}'s personal AI assistant bot.

═══════════════════════════════════════════
🎯 YOUR IDENTITY
═══════════════════════════════════════════
- Name: Anu
- Role: ${ownerName}'s AI assistant
- You work FOR ${ownerName}. You are NOT ${ownerName}.
- Speak about ${ownerName} in THIRD PERSON.

═══════════════════════════════════════════
🧠 THINK DEEPLY BEFORE REPLYING (INTERNAL)
═══════════════════════════════════════════
Silently analyze:
1. **Language**: Amharic? English? Amharic-in-Latin (selam, wendme)?
2. **Gender**: Male (wendme, ante, neh) or female (anchi, nesh)?
3. **Emotion**: Happy, sad, angry, urgent, casual?
4. **Intent**: Greeting? Question? Request?
5. **Proper Amharic**: What's the CORRECT phrase?

Then reply naturally in EXACTLY the same language style.

═══════════════════════════════════════════
🚨 LANGUAGE RULES
═══════════════════════════════════════════

**Amharic-in-Latin** (MOST COMMON) — reply in SAME Latin style:
- "selam"/"salam" → "selam! endet neh?"
- "wendme" → "wendme! endet neh?"
- "bro" → "bro! endet neh?"
- "ante" → "aye! endet neh?"
- "dehna neh?" → "dehna negn! antes?"
- "endet neh?" → "dehna negn! antes?"
- "man neh?"/"man new?" → "ene Anu negn — ye ${ownerName} redat"
- "amesegnalehu" → "amesegnalehu wendme! 😊"

**Amharic (Ge'ez)** — reply in Ge'ez:
- "ሰላም" → "ሰላም! እንዴት ነህ?"
- "ደህና ነህ?" → "ደህና ነኝ! አንተስ?"
- "ማን ነህ?" → "እኔ Anu ነኝ — የ ${ownerName} ረዳት"
- "አመሰግናለሁ" → "አመሰግናለሁ ወንድሜ! 😊"

**English**:
- "Hi" → "Hi! How can I help you?"
- "How are you?" → "Great, thanks! You?"
- "Who are you?" → "I'm Anu, ${ownerName}'s AI assistant"

═══════════════════════════════════════════
👤 GENDER DETECTION
═══════════════════════════════════════════
- "wendme", "ante", "neh" → MALE
- "anchi", "nesh" → FEMALE
- Unsure → NEUTRAL

═══════════════════════════════════════════
🆔 WHEN TO MENTION IDENTITY
═══════════════════════════════════════════
Say "I'm Anu" ONLY when:
- ✅ They ask "who are you?" / "ማን ነህ?"
- ✅ They ask "are you ${ownerName}?"
- ✅ FIRST contact ever

DO NOT mention identity:
- ❌ Regular conversation
- ❌ After first intro
- ❌ Just saying hi

═══════════════════════════════════════════
🎯 WHEN ASKED ABOUT ${ownerName.toUpperCase()}
═══════════════════════════════════════════
- "${ownerName} ይኖራል?" / "Is ${ownerName} there?" / "${ownerName} አለ?"
  → No status: "${ownerName} አለ! ለምን እንደሚፈልጉት ከነገሩኝ አሳውቀዋለሁ"
  → With status: "${ownerName} ${statusText}"

- "${ownerName} የት ነው?" / "Where is ${ownerName}?"
  → Status: "${ownerName} ${statusText}"
  → No status: "${ownerName} አሁን አይገኝም። ለምን እንደሚፈልጉት ከነገሩኝ አሳውቀዋለሁ"

- "ጥራው" / "አሳውቅ" / "Tell ${ownerName}"
  → "እሺ! ${ownerName} ን አሳውቀዋለሁ 🙏"

- "who is ${ownerName}?" / "${ownerName} ማን ነው?"
  → "${ownerName} አለቃዬ ነው — ጥሩ ሰው 😊"

═══════════════════════════════════════════
💬 STYLE
═══════════════════════════════════════════
- Short (1-2 sentences)
- Warm and natural
- Ethiopian friendliness
- Natural emojis (😊 🙏 ✨ 💛)

═══════════════════════════════════════════
📸 PHOTOS
═══════════════════════════════════════════
Warm genuine reaction, 1-2 sentences.

═══════════════════════════════════════════
😠 INSULTS
═══════════════════════════════════════════
NEVER insult back: "ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ?"

═══════════════════════════════════════════
🚫 FORBIDDEN
═══════════════════════════════════════════
- NEVER reveal AI model names
- NEVER show reasoning or analysis
- NEVER say "I am ${ownerName}"
- NEVER echo their words back

═══════════════════════════════════════════
📝 OUTPUT
═══════════════════════════════════════════
Output ONLY the reply text. No reasoning, no drafts, no meta, no quotes.${statusBlock}`;
}

/* ═══════════════════════════════════════════════════════════
   WEAK REPLY DETECTOR
   ═══════════════════════════════════════════════════════════ */
function isWeak(reply, userText) {
  if (!reply) return true;
  const r = reply.toLowerCase().trim();
  const u = (userText || '').toLowerCase().trim();

  if (r.length < 8) return true;
  if (r === u) return true;
  if (/^(hi|hello|hey|selam|salam|wendme|ሰላም|hi!|hello!|ሰላም!)[\s!?.😊🙏😄]*$/i.test(r)) return true;

  const askedIdentity = /(who are you|who r u|ማን ነህ|ማን ነሽ|who is this|man neh|man new|introduce yourself|ማን ነው)/i.test(u);
  if (askedIdentity && !/anu/i.test(r)) return true;

  return false;
}

/* ═══════════════════════════════════════════════════════════
   TYPING INDICATOR — refresh every 4 seconds
   ═══════════════════════════════════════════════════════════ */
function startTypingLoop(tg, chatId, bizConnId, isPhoto) {
  const action = isPhoto ? 'upload_photo' : 'typing';
  const payload = { chat_id: chatId, action };
  if (bizConnId) payload.business_connection_id = bizConnId;

  // Send immediately
  tg('sendChatAction', payload).catch(() => {});

  // Refresh every 4 seconds (Telegram typing lasts ~5s)
  const interval = setInterval(() => {
    tg('sendChatAction', payload).catch(() => {});
  }, 4000);

  return () => clearInterval(interval);
}

/* ═══════════════════════════════════════════════════════════
   GENERATE REPLY
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, userText, chatId, isFirst, status) {
  const sys = sysPrompt(ownerName, senderName, status);
  const hist = getHist(chatId).slice(-8).map(h => ({ role: h.role, content: h.content }));

  /* ─── FIRST CONTACT ─── */
  if (isFirst) {
    const introPrompt = `${sys}

═══════════════════════════════════════════
🎯 FIRST CONTACT
═══════════════════════════════════════════
This is the FIRST message from "${senderName}".

MUST DO:
1. Introduce yourself as "Anu, ${ownerName}'s AI assistant"
2. Give TWO options:
   • Send a message to ${ownerName} (I'll forward)
   • Get help from me directly
3. Ask which they prefer
4. Match their EXACT language style
5. Keep it SHORT (2-3 sentences)

MUST include "Anu"!`;

    const r = await callAI(introPrompt, [{ role: 'user', content: userText }], {
      maxTokens: 300,
      temperature: 0.85,
      timeoutMs: 12000
    });

    if (r.ok && /anu/i.test(r.content) && r.content.length > 30) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', r.content);
      return r.content;
    }

    // Guaranteed fallback
    const isAmharic = /[\u1200-\u137F]/.test(userText);
    const isLatin = /(selam|salam|dehna|endet|amesegn|wendme|bro|ante|anchi)/i.test(userText);
    let fb;
    if (isAmharic) {
      fb = `ሰላም ${senderName}! እኔ Anu ነኝ — የ ${ownerName} AI ረዳት 🤖\nለ ${ownerName} መልእክት ልላክ ወይስ ጥያቄ ልርዳህ? 💛`;
    } else if (isLatin) {
      fb = `selam ${senderName}! ene Anu negn — ye ${ownerName} AI redat 🤖\nLe ${ownerName} message lilak weys question lirdah? 💛`;
    } else {
      fb = `Hi ${senderName}! I'm Anu, ${ownerName}'s AI assistant 🤖\nI can help you with anything, or forward a message to ${ownerName}.\nWhat would you like? 💛`;
    }
    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', fb);
    return fb;
  }

  /* ─── REGULAR ─── */
  const userContent = `${senderName}: "${userText}"`;
  const r = await callAI(sys, [...hist, { role: 'user', content: userContent }], {
    maxTokens: 250,
    temperature: 0.85,
    timeoutMs: 12000
  });

  if (r.ok && !isWeak(r.content, userText)) {
    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', r.content);
    return r.content;
  }

  /* ─── Retry if weak ─── */
  if (r.ok) {
    console.warn('[Anu] Weak reply, retrying:', r.content?.slice(0, 60));
    const retrySys = `${sys}

🚨 RETRY: Previous reply was too weak.
- Match their exact language
- Natural, 1-2 short sentences
- If they asked identity → say "Anu"
- If about ${ownerName} → say you'll notify him`;

    const retry = await callAI(retrySys, [{ role: 'user', content: userContent }], {
      maxTokens: 250,
      temperature: 0.9,
      timeoutMs: 10000
    });

    if (retry.ok && retry.content.length > 8 && !isWeak(retry.content, userText)) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', retry.content);
      return retry.content;
    }
  }

  /* ─── Guaranteed fallback ─── */
  const isAmharic = /[\u1200-\u137F]/.test(userText);
  const isLatin = /(selam|salam|dehna|endet|amesegn|wendme|bro|ante)/i.test(userText);
  let fb;
  if (isAmharic) fb = `ሰላም! እንዴት ነህ? 😊`;
  else if (isLatin) fb = `selam! endet neh? 😊`;
  else fb = `Hey! How are you? 😊`;

  addHist(chatId, 'user', userText);
  addHist(chatId, 'assistant', fb);
  return fb;
}

/* ═══════════════════════════════════════════════════════════
   PHOTO
   ═══════════════════════════════════════════════════════════ */
async function analyzePhoto(ownerName, senderName, userText, isFirst, status) {
  const sys = sysPrompt(ownerName, senderName, status);
  const ctx = userText
    ? `[${senderName} sent a photo with caption: "${userText}"]`
    : `[${senderName} sent a photo]`;

  const instruction = isFirst
    ? `${ctx}\n\nAcknowledge the photo AND introduce yourself as "Anu, ${ownerName}'s assistant".`
    : `${ctx}\n\nReact warmly — 1-2 sentences.`;

  const r = await callAI(sys, [{ role: 'user', content: instruction }], {
    maxTokens: 200,
    temperature: 0.85,
    timeoutMs: 10000
  });

  if (r.ok && r.content && r.content.length > 10) {
    if (isFirst && !/anu/i.test(r.content)) {
      return `Nice photo! I'm Anu, ${ownerName}'s assistant 😊 What can I help with?`;
    }
    return r.content;
  }
  return `Nice photo! 😊`;
}

/* ═══════════════════════════════════════════════════════════
   DETECTION
   ═══════════════════════════════════════════════════════════ */
function wantsOwner(text) {
  const t = (text || '').toLowerCase();

  const amharic = [
    /አናንያ|አናኒ/,
    /ባለቤት|አስቸኳይ|አስፈላጊ|ንግድ|ጉዳይ|ስብሰባ|ቀጠሮ/,
    /ንገረው|ንገራት|አሳውቅ|አሳውቂ|አሳውቀው|አስታውቅ/,
    /ጥራው|ጥራት|ጥሪው|ደውልለት|ደውልላት|አግኚ|አግኝ/,
    /ልናገር|ልናገራት|ልናገረው/
  ];

  const english = [
    /\b(ananya|anani|owner|boss)\b/i,
    /\b(tell her|tell him|tell ananya|notify|reach her|reach him)\b/i,
    /\b(contact her|contact him|let her know|let him know)\b/i,
    /\b(pass this|forward this|call her|call him)\b/i,
    /\b(urgent|emergency|important|meet|meeting|business)\b/i
  ];

  const latin = [
    /\b(ananya|anani|nigerew|nigerat|asawq|asekayi|guday|sbsba|qetro)\b/i,
    /\b(traw|tirat|dewil|ageni|nager|lenager|lenagrat|lenagerew)\b/i
  ];

  return amharic.some(p => p.test(t)) || english.some(p => p.test(t)) || latin.some(p => p.test(t));
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
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Bot v17.1',
      identity: "Anu — Ananya's AI assistant",
      storage: 'Firebase + memory',
      fixes: ['null-status', 'typing-loop', 'fast-ai']
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
          `✅ <b>Anu Bot v17.1</b>\n\n` +
          `🤖 Anu — ${esc(OWNER_NAME)}'s AI assistant\n\n` +
          `<b>Owner Commands:</b>\n` +
          `<code>/start</code> — This menu\n` +
          `<code>/status &lt;text&gt;</code> — Set today's status\n` +
          `<code>/status</code> — Show status\n` +
          `<code>/status clear</code> — Clear status\n` +
          `<code>/stats</code> — Bot info\n` +
          `<code>/pause</code> — Pause AI\n` +
          `<code>/resume</code> — Resume AI\n` +
          `<code>/send &lt;chat_id&gt; &lt;text&gt;</code> — Direct message\n` +
          `<code>/help</code> — Help\n\n` +
          (statusText
            ? `📢 <b>Current status:</b>\n<i>"${esc(statusText)}"</i>`
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
            ? `📢 <b>Today's status:</b>\n<i>"${esc(statusText)}"</i>`
            : `ℹ️ No status set.\n\nUse: <code>/status ዛሬ አሞኛል</code>`,
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }

      if (arg === 'clear' || arg === 'delete' || arg === 'off') {
        await clearStatus();
        await tg('sendMessage', {
          chat_id: chatId,
          text: '✅ Status cleared.'
        });
        return res.status(200).json({ ok: true });
      }

      await setStatus(arg, OWNER_NAME);
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `✅ <b>Status set!</b>\n\n` +
          `📢 <i>"${esc(arg)}"</i>\n\n` +
          `💬 Bot will tell senders this when they ask about you.`,
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
          `• <code>/status &lt;text&gt;</code> — Set today's status\n` +
          `• <code>/status clear</code> — Remove\n` +
          `• <code>/send &lt;chat_id&gt; &lt;text&gt;</code> — Direct\n` +
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
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 <b>Bot Status</b>\n\n` +
          `✅ Online\n` +
          `🧠 Model: Deep thinking\n` +
          `💾 Storage: Firebase + Memory\n` +
          `💬 History: ${state.history.size} chats\n` +
          `👥 Known: ${state.introduced.size} users\n` +
          `⏸️ Paused: ${state.paused ? 'Yes' : 'No'}\n` +
          `📢 Today status: ${statusText ? 'Set ✅' : 'None'}`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 6️⃣ OWNER /pause ─── */
    if (isFromOwner && txt === '/pause') {
      state.paused = true;
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ AI paused.' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 7️⃣ OWNER /resume ─── */
    if (isFromOwner && txt === '/resume') {
      state.paused = false;
      await tg('sendMessage', { chat_id: chatId, text: '▶️ AI resumed.' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 8️⃣ OWNER /send ─── */
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
      return res.status(200).json({ ok: true });
    }

    /* ─── 9️⃣ NON-OWNER DIRECT ─── */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      if (state.paused) return res.status(200).json({ ok: true });

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !state.introduced.has(String(chatId));

      console.log('[Anu] DM from', firstName, '| first:', isFirst);

      const status = await getStatus();
      const reply = await generateReply(OWNER_NAME, firstName, txt, chatId, isFirst, status);
      const finalMsg = `anu bot: ${reply}`;

      await tg('sendMessage', {
        chat_id: chatId,
        text: finalMsg,
        reply_to_message_id: dm.message_id
      });

      if (isFirst) state.introduced.add(String(chatId));

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
            `🤖 anu bot: <i>"${esc(reply.slice(0, 180))}${reply.length > 180 ? '…' : ''}"</i>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `↩️ Reply to this message to send your own reply\n` +
            `📎 Or use: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
            `REF:${chatId}:direct`,
          parse_mode: 'HTML'
        });
      }

      return res.status(200).json({ ok: true });
    }

    /* Non-owner /start */
    if (!isFromOwner && txt === '/start') {
      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !state.introduced.has(String(chatId));

      const status = await getStatus();
      const reply = await generateReply(OWNER_NAME, firstName, '/start', chatId, isFirst, status);

      await tg('sendMessage', { chat_id: chatId, text: `anu bot: ${reply}` });
      if (isFirst) state.introduced.add(String(chatId));
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

  if (state.paused) return res.status(200).json({ ok: true });

  let userText = '';
  let isPhoto = false;

  if (message.text) userText = message.text.trim();
  else if (message.caption) userText = message.caption.trim();
  if (message.photo && message.photo.length > 0) isPhoto = true;

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  const firstName = senderName.split(' ')[0];
  const isFirst = !state.introduced.has(String(chatId));

  console.log('[Anu] Business from', firstName, '| first:', isFirst);

  /* ─── Start typing loop (auto-refresh every 4s) ─── */
  const stopTyping = startTypingLoop(tg, chatId, bizConnId, isPhoto);

  const status = await getStatus();
  let reply = '';
  try {
    if (isPhoto) {
      reply = await analyzePhoto(OWNER_NAME, firstName, userText, isFirst, status);
    } else {
      reply = await generateReply(OWNER_NAME, firstName, userText, chatId, isFirst, status);
    }
  } finally {
    stopTyping(); // Always stop typing indicator
  }

  if (!reply) reply = `Hey! How are you? 😊`;

  const finalMsg = `anu bot: ${reply}`;

  await tg('sendMessage', {
    chat_id: chatId,
    text: finalMsg,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  });

  if (isFirst) state.introduced.add(String(chatId));

  /* Escalation */
  const sentiment = detectSentiment(userText);
  const needsOwner = wantsOwner(userText);

  if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
    let emoji = '🔔', label = 'Message';
    if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
    else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
    else if (needsOwner) { emoji = '📩'; label = 'Wants your attention'; }

    await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text:
        `${emoji} <b>${esc(label)}</b> from <b>${esc(firstName)}</b>\n\n` +
        `💬 <i>"${esc(userText || '[photo]')}"</i>\n\n` +
        `🤖 anu bot: <i>"${esc(reply.slice(0, 180))}${reply.length > 180 ? '…' : ''}"</i>\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `↩️ Reply to this message to send your own reply\n` +
        `📎 Or use: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
        `REF:${chatId}:${bizConnId}`,
      parse_mode: 'HTML'
    });
  }

  return res.status(200).json({ ok: true });
}
