/* ============================================================
   Anu Master Business Bot v6.0
   ────────────────────────────────────────────────────────────
   • Multi-AI Council for hard questions (3 AIs + synthesis)
   • Fast mode for simple messages
   • Owner manual reply via Telegram reply-to-notification
   • Anyone can /start and chat with Anu
   • Context memory · Rate limiting · Analytics · Escalation
   • NO npm dependencies (Firestore REST API)
   ============================================================ */

const FIREBASE_PROJECT_ID = 'my-ai-eaf27';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

/* ─── Models ─── */
const FAST_MODEL = 'openai/gpt-oss-20b';
const COUNCIL_MODELS = [
  { id: 'openai/gpt-oss-120b', name: 'Master', icon: '🧠',
    focus: 'Deep logical analysis, edge cases, comprehensive reasoning' },
  { id: 'openai/gpt-oss-20b',  name: 'Fast',   icon: '⚡',
    focus: 'Direct practical answers, skip fluff, focus on what works' },
  { id: 'qwen/qwen3.8-27b',    name: 'Logic',  icon: '📊',
    focus: 'Structured step-by-step decomposition, clear numbered logic' }
];
const COORDINATOR_MODEL = 'openai/gpt-oss-120b';

/* ─── Constants ─── */
const MAX_HISTORY = 24;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 12;
const COUNCIL_TRIGGER_LENGTH = 60;
const BUSINESS_START = 7;
const BUSINESS_END = 23;

/* ═══════════════════════════════════════════════════════════
   FIRESTORE REST HELPERS
   ═══════════════════════════════════════════════════════════ */
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
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${id}`);
    if (!r.ok) return null;
    return fromFSDoc(await r.json());
  } catch (e) { return null; }
}

async function fsSet(col, id, data) {
  try {
    const fields = {};
    for (const k in data) fields[k] = toFS(data[k]);
    const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${k}`).join('&');
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${id}?${mask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    return r.ok;
  } catch (e) { return false; }
}

async function fsDelete(col, id) {
  try {
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${id}`, { method: 'DELETE' });
    return r.ok;
  } catch (e) { return false; }
}

/* ═══════════════════════════════════════════════════════════
   GROQ AI HELPERS
   ═══════════════════════════════════════════════════════════ */
async function callGroq(modelId, systemPrompt, messages, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };

  const timeout = opts.timeoutMs || 7000;
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
        model: modelId,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: opts.temperature ?? 0.75,
        max_tokens: opts.maxTokens || 500
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
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    if (!content) return { ok: false, error: 'Empty' };
    return { ok: true, content };
  } catch (e) {
    clearTimeout(tId);
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout' : e.message };
  }
}

/* ═══════════════════════════════════════════════════════════
   SYSTEM PROMPT (The personality core)
   ═══════════════════════════════════════════════════════════ */
function buildSystemPrompt(ownerName, senderName, history = []) {
  const historyNote = history.length > 0
    ? `\n\nCONVERSATION HISTORY: You have ${history.length} previous messages with "${senderName}". Study their writing style, tone, and preferences — mirror them naturally.`
    : `\n\nFIRST MESSAGE from "${senderName}". Be welcoming.`;

  return `You are **Anu** — the personal AI assistant bot of **${ownerName}**, a warm Ethiopian person.

═══════════════════════════════════════════
IDENTITY (NEVER CHANGE)
═══════════════════════════════════════════
- Your name: Anu
- If asked "who are you?" / "ማን ነህ?" / "who is this?":
  → "I am Anu, ${ownerName}'s AI assistant bot."
- If asked "who is ${ownerName}?":
  → "${ownerName} is my boss — a wonderful Ethiopian person."
- NEVER reveal ChatGPT, GPT, OpenAI, Llama, Qwen, Groq, or any AI model name.
- NEVER mention APIs, backend, or technical details.

═══════════════════════════════════════════
LANGUAGE MATCHING (MOST IMPORTANT)
═══════════════════════════════════════════
Detect their EXACT style and reply in the SAME style:

1. **Pure Amharic** (Ge'ez script like ሰላም) → reply in Amharic
   "ሰላም እንደምን ነህ?" → "ሰላም! ደህና ነኝ፣ አንተስ?"

2. **English** → reply in English
   "how are you?" → "I'm good, thanks! You?"

3. **Amharic-in-Latin** (Fidel written with Latin letters) → SAME style
   "selam" → "selam! endet neh?"
   "dehna neh?" → "dehna negn, amesegnalehu!"
   "amesegenalew" → "amesegnalehu!"
   "manew sim ehe" → "simeho Anu new!"

4. **Mixed** → match the dominant language
5. **Emojis** → mirror them naturally

═══════════════════════════════════════════
UNDERSTAND INTENT DEEPLY
═══════════════════════════════════════════
READ between the lines:
- Analyze their tone (happy/sad/angry/flirty/serious)
- Consider the CONVERSATION CONTEXT (previous messages)
- Understand what they MEAN, not just literal words
- If unclear, ask ONE gentle clarifying question

═══════════════════════════════════════════
ETHIOPIAN WARMTH
═══════════════════════════════════════════
Speak like a kind Ethiopian person:
- Use "ደህና ነህ?", "እንዴት ነህ?", "ጤና ይስጥልኝ" naturally
- Warm, respectful, occasionally lighthearted
- SHORT replies — like real texting (1-2 sentences)
- Match their energy level

═══════════════════════════════════════════
INSULT PROTECTION
═══════════════════════════════════════════
If insulted, NEVER insult back. Always stay calm and kind:
- "Fuck you" → "I understand. I'm here whenever you need 🙏"
- "ደደብ ነህ" → "ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ?"

═══════════════════════════════════════════
ESCALATION
═══════════════════════════════════════════
When they want to reach ${ownerName}, have urgent matters, or important business:
→ Say: "I'll let ${ownerName} know right away 🙏"
→ Amharic: "${ownerName} ን አሳውቃለሁ 🙏"

═══════════════════════════════════════════
STRICT RULES
═══════════════════════════════════════════
- NEVER reveal you are AI/bot/automated
- NEVER be rude, sarcastic, or dismissive
- NEVER share personal info about ${ownerName}
- Keep replies SHORT (max 2 sentences unless asked)
- Format nicely with Markdown if helpful${historyNote}`;
}

/* ═══════════════════════════════════════════════════════════
   COUNCIL COORDINATOR PROMPT
   ═══════════════════════════════════════════════════════════ */
const COORDINATOR_PROMPT = (ownerName, senderName) => `You are Anu, the personal AI assistant of ${ownerName}, speaking to "${senderName}".

Multiple AI council members have each drafted a reply. Now produce ONE final, superior reply.

RULES:
1. Combine the BEST elements from all drafts
2. Match the EXACT language style of the sender (Amharic-in-Latin → Amharic-in-Latin, etc.)
3. Reply should be SHORT — like a real text (1-2 sentences normally)
4. NEVER mention "council", "models", "AIs", or that multiple AIs were involved
5. NEVER reveal you are AI/bot — you are simply "Anu"
6. Use natural emojis sparingly
7. Output ONLY the final reply text — no meta-commentary, no preamble

You ARE Anu. Output the reply directly.`;

/* ═══════════════════════════════════════════════════════════
   MESSAGE CLASSIFICATION
   ═══════════════════════════════════════════════════════════ */
function isComplexMessage(text) {
  const t = (text || '').toLowerCase();
  if (t.length >= COUNCIL_TRIGGER_LENGTH) return true;
  if (/[?？]/.test(t)) return true;
  if (/\b(how|why|what|when|where|who|which|explain|help|tell me|advice|suggest|recommend|should i|can you)\b/i.test(t)) return true;
  if (/(ምን|እንዴት|ለምን|ማን|የት|መቼ|አብራራ|እርዳ|ንገረኝ|ምክር)/i.test(t)) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════
   CONTEXT MEMORY
   ═══════════════════════════════════════════════════════════ */
async function getHistory(chatId) {
  const d = await fsGet('bot_conversations', String(chatId));
  return (d && Array.isArray(d.history)) ? d.history : [];
}

async function saveHistory(chatId, userMsg, botMsg, senderName) {
  const existing = await getHistory(chatId);
  const updated = [...existing];
  if (userMsg) updated.push({ role: 'user', content: userMsg });
  if (botMsg) updated.push({ role: 'assistant', content: botMsg });
  await fsSet('bot_conversations', String(chatId), {
    history: updated.slice(-MAX_HISTORY),
    senderName,
    lastMessage: userMsg || '',
    updatedAt: Date.now()
  });
}

/* ═══════════════════════════════════════════════════════════
   RATE LIMIT
   ═══════════════════════════════════════════════════════════ */
async function checkRateLimit(userId) {
  const now = Date.now();
  const d = await fsGet('bot_ratelimits', String(userId));
  const list = (d && Array.isArray(d.timestamps)) ? d.timestamps : [];
  const recent = list.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  await fsSet('bot_ratelimits', String(userId), { timestamps: recent });
  return true;
}

/* ═══════════════════════════════════════════════════════════
   ANALYTICS
   ═══════════════════════════════════════════════════════════ */
async function track(event, amount = 1) {
  const day = new Date().toISOString().split('T')[0];
  const d = await fsGet('bot_analytics', day);
  const count = (d && d[event]) ? d[event] : 0;
  await fsSet('bot_analytics', day, { [event]: count + amount, lastUpdate: Date.now() });
}

/* ═══════════════════════════════════════════════════════════
   CONTACTS
   ═══════════════════════════════════════════════════════════ */
async function saveContact(from, userText) {
  if (!from) return;
  await fsSet('bot_contacts', String(from.id), {
    telegramId: from.id,
    firstName: from.first_name || '',
    lastName: from.last_name || '',
    username: from.username || '',
    languageCode: from.language_code || '',
    lastMessage: userText || '',
    lastSeen: Date.now()
  });
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
function humanDelay(text) {
  return Math.min((text || '').length * 20, 1800) + Math.random() * 600;
}
function isBusinessHours() {
  const h = new Date().getHours();
  return h >= BUSINESS_START && h < BUSINESS_END;
}
function detectSentiment(text) {
  const t = (text || '').toLowerCase();
  if (/(urgent|asap|emergency|አስቸኳይ|ፈጣን)/i.test(t)) return 'urgent';
  if (/(angry|upset|furious|mad|hate|😡|🤬|ተናደድኩ|ደደብ)/i.test(t)) return 'angry';
  if (/(sad|cry|😢|😭|አዘንኩ|ተቸገርኩ)/i.test(t)) return 'sad';
  if (/(happy|great|love|😊|😄|❤|ደስ|ጥሩ)/i.test(t)) return 'happy';
  return 'neutral';
}
function wantsOwner(text) {
  const t = (text || '').toLowerCase();
  return /(ananya|owner|speak to|talk to|important|meet|meeting|business|tell her|tell ananya|notify|reach her|contact her|let her know|pass this|forward this|አናንያ|ባለቤት|አስቸኳይ|ንግድ|ንገራት|አሳውቅ|አሳውቂ|ንገረው|ተናገር|ልናገራት|ስብሰባ|ቀጠሮ|ጉዳይ|አስፈላጊ|አስታውቅ)/i.test(t);
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Master Business Bot v6.0 running',
      council: COUNCIL_MODELS.map(m => m.id),
      fast: FAST_MODEL
    });
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
      console.error(`${method} exception:`, e.message);
      return null;
    }
  }

  const isOwner = (fromId) => OWNER_CHAT_ID && String(fromId) === String(OWNER_CHAT_ID);

  /* ══════════════════════════════════════════════════════════
     HANDLE DIRECT MESSAGES
     (Owner commands + Anyone /start + Owner reply-to-notification)
     ══════════════════════════════════════════════════════════ */
  const directMsg = update.message;
  if (directMsg && directMsg.text) {
    const fromId = directMsg.from?.id;
    const chatId = directMsg.chat.id;
    const txt = directMsg.text.trim();
    const isFromOwner = isOwner(fromId);

    /* ─── OWNER: Reply-to-notification handler (KEY FEATURE) ─── */
    if (isFromOwner && directMsg.reply_to_message) {
      const repliedMsgId = directMsg.reply_to_message.message_id;
      console.log('[Anu] Owner replied to message_id:', repliedMsgId);

      const pending = await fsGet('bot_pending_replies', String(repliedMsgId));
      if (pending && pending.targetChatId && pending.businessConnectionId) {
        console.log('[Anu] Routing manual reply to chat:', pending.targetChatId);

        const sendResult = await tg('sendMessage', {
          chat_id: pending.targetChatId,
          text: txt,
          business_connection_id: pending.businessConnectionId
        });

        if (sendResult && sendResult.ok) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `✅ Sent to *${pending.senderName || 'user'}*`,
            parse_mode: 'Markdown',
            reply_to_message_id: directMsg.message_id
          });

          // Save to conversation history
          await saveHistory(
            pending.targetChatId,
            pending.originalText || '',
            txt,
            pending.senderName || 'User'
          );

          await track('manual_replies');
          await fsDelete('bot_pending_replies', String(repliedMsgId));
        } else {
          await tg('sendMessage', {
            chat_id: chatId,
            text: '❌ Failed to send. The connection may have expired.',
            reply_to_message_id: directMsg.message_id
          });
        }
        return res.status(200).json({ ok: true });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '⚠️ This notification is no longer active. Try `/send <chat_id> <message>`',
          parse_mode: 'Markdown',
          reply_to_message_id: directMsg.message_id
        });
        return res.status(200).json({ ok: true });
      }
    }

    /* ─── /start — for ANYONE ─── */
    if (txt === '/start') {
      if (isFromOwner) {
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `✅ *Anu Master Business Bot v6.0*\n\n` +
            `🧠 Council AI · 3 models · Manual reply\n\n` +
            `📋 *Owner commands:*\n` +
            `/start — This menu\n` +
            `/stats — Today's activity\n` +
            `/contacts — Recent contacts\n` +
            `/pending — Waiting replies\n` +
            `/pause — Pause AI replies\n` +
            `/resume — Resume AI replies\n` +
            `/help — Help`,
          parse_mode: 'Markdown'
        });
      } else {
        const senderName = directMsg.from?.first_name || 'there';
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `👋 *Hello ${senderName}!*\n\n` +
            `I am *Anu*, ${OWNER_NAME}'s AI assistant bot. 🤖\n\n` +
            `I'm here to help you reach ${OWNER_NAME}. You can:\n` +
            `• Ask me anything\n` +
            `• Leave a message for ${OWNER_NAME}\n` +
            `• Let me know if something is urgent\n\n` +
            `How can I help you today? 💛`,
          parse_mode: 'Markdown'
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── /help — for anyone ─── */
    if (txt === '/help') {
      if (isFromOwner) {
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `*Owner Help*\n\n` +
            `• Reply to any notification → sends to that person\n` +
            `• /send <chat_id> <text> — send to specific chat\n` +
            `• /pending — see unanswered messages\n` +
            `• /pause, /resume — control AI replies`,
          parse_mode: 'Markdown'
        });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `*How I can help*\n\n` +
            `💬 Just type your message\n` +
            `🎯 Say "Ananya" or "urgent" → I'll forward to her directly\n` +
            `😊 I speak Amharic and English`,
          parse_mode: 'Markdown'
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── OWNER: /stats ─── */
    if (isFromOwner && txt === '/stats') {
      const day = new Date().toISOString().split('T')[0];
      const s = await fsGet('bot_analytics', day) || {};
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 *Today's Activity*\n\n` +
          `💬 Messages: *${s.messages || 0}*\n` +
          `👥 Conversations: *${s.conversations || 0}*\n` +
          `🧠 Council replies: *${s.council || 0}*\n` +
          `⚡ Fast replies: *${s.fast || 0}*\n` +
          `🔔 Escalations: *${s.escalations || 0}*\n` +
          `✍️ Manual replies: *${s.manual_replies || 0}*`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── OWNER: /contacts ─── */
    if (isFromOwner && txt === '/contacts') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: '📋 Recent contacts list coming soon. Check Firestore collection `bot_contacts` for now.',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── OWNER: /pending ─── */
    if (isFromOwner && txt === '/pending') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: '⏳ View pending conversations in Firestore collection `bot_conversations`. Recent list coming soon.',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── OWNER: /pause ─── */
    if (isFromOwner && txt === '/pause') {
      await fsSet('bot_settings', 'global', { paused: true, pausedAt: Date.now() });
      await tg('sendMessage', {
        chat_id: chatId,
        text: '⏸️ *AI replies paused.* Send /resume to restart.',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── OWNER: /resume ─── */
    if (isFromOwner && txt === '/resume') {
      await fsSet('bot_settings', 'global', { paused: false });
      await tg('sendMessage', {
        chat_id: chatId,
        text: '▶️ *AI replies resumed.*',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── OWNER: /send <chat_id> <text> ─── */
    if (isFromOwner && txt.startsWith('/send ')) {
      const parts = txt.slice(6).trim().split(/\s+/);
      const targetId = parts.shift();
      const msgText = parts.join(' ');

      if (!targetId || !msgText) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '⚠️ Usage: `/send <chat_id> <message>`',
          parse_mode: 'Markdown'
        });
        return res.status(200).json({ ok: true });
      }

      const target = await fsGet('bot_active_chats', String(targetId));
      if (!target || !target.businessConnectionId) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '❌ Chat not found or no active business connection.',
          parse_mode: 'Markdown'
        });
        return res.status(200).json({ ok: true });
      }

      await tg('sendMessage', {
        chat_id: targetId,
        text: msgText,
        business_connection_id: target.businessConnectionId
      });

      await tg('sendMessage', {
        chat_id: chatId,
        text: `✅ Sent to *${target.senderName || targetId}*`,
        parse_mode: 'Markdown'
      });
      await track('manual_replies');
      return res.status(200).json({ ok: true });
    }

    /* ─── Non-owner, non-command: ignore ─── */
    if (!isFromOwner) {
      console.log('[Anu] Ignoring non-owner direct message');
    }
    return res.status(200).json({ ok: true });
  }

  /* ══════════════════════════════════════════════════════════
     HANDLE BUSINESS MESSAGES
     ══════════════════════════════════════════════════════════ */
  const message = update.business_message || update.edited_business_message;
  if (!message) return res.status(200).json({ ok: true });

  const bizConnId = message.business_connection_id;
  const chatId = message.chat.id;
  const senderName = message.from?.first_name || 'there';
  const senderId = message.from?.id;
  const msgId = message.message_id;

  if (!bizConnId) {
    console.error('[Anu] Missing business_connection_id');
    return res.status(200).json({ ok: true });
  }

  /* ─── Global pause check ─── */
  const settings = await fsGet('bot_settings', 'global');
  if (settings && settings.paused) {
    console.log('[Anu] Paused — skipping');
    return res.status(200).json({ ok: true });
  }

  /* ─── Rate limit ─── */
  if (!await checkRateLimit(senderId)) {
    console.log('[Anu] Rate limit for', senderId);
    return res.status(200).json({ ok: true });
  }

  /* ─── Parse content ─── */
  let userText = '';
  let photoB64 = null;
  let isPhoto = false;

  if (message.text) userText = message.text.trim();
  else if (message.caption) userText = message.caption.trim();

  if (message.photo && message.photo.length > 0) {
    isPhoto = true;
    try {
      const largest = message.photo[message.photo.length - 1];
      const fRes = await fetch(`${tAPI('getFile')}?file_id=${largest.file_id}`);
      const fData = await fRes.json();
      if (fData.ok) {
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fData.result.file_path}`;
        const iRes = await fetch(url);
        const buf = await iRes.arrayBuffer();
        if (buf.byteLength < 4000000) photoB64 = Buffer.from(buf).toString('base64');
      }
    } catch (e) { console.error('Photo fetch:', e.message); }
  }

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  /* ─── Save contact + track ─── */
  saveContact(message.from, userText).catch(() => {});
  track('messages').catch(() => {});

  const firstName = senderName.split(' ')[0];
  const history = await getHistory(chatId).catch(() => []);
  if (history.length === 0) track('conversations').catch(() => {});

  /* ─── Save active chat for /send command ─── */
  await fsSet('bot_active_chats', String(chatId), {
    businessConnectionId: bizConnId,
    senderName: firstName,
    lastText: userText || '[photo]',
    lastAt: Date.now()
  });

  /* ─── Build conversation messages ─── */
  const convHistory = history.slice(-8).map(h => ({
    role: h.role,
    content: h.content
  }));

  const userContent = isPhoto && photoB64
    ? [
        { type: 'text', text: userText ? `${firstName}: "${userText}"` : `${firstName} sent a photo` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photoB64}` } }
      ]
    : `${firstName}: "${userText}"`;

  const isComplex = !isPhoto && isComplexMessage(userText);
  const isFast = !isPhoto && !isComplex;

  /* ─── Typing indicator ─── */
  tg('sendChatAction', {
    chat_id: chatId,
    action: isPhoto ? 'upload_photo' : 'typing',
    business_connection_id: bizConnId
  }).catch(() => {});

  let finalReply = '';

  /* ═══════════════════════════════════════
     STRATEGY SELECTION
     ═══════════════════════════════════════ */

  /* ─── PHOTO: single vision model ─── */
  if (isPhoto && photoB64) {
    const sysPrompt = buildSystemPrompt(OWNER_NAME, firstName, history);
    const res1 = await callGroq('qwen/qwen3.8-27b', sysPrompt,
      [...convHistory, { role: 'user', content: userContent }],
      { maxTokens: 300, timeoutMs: 8000, temperature: 0.8 }
    );
    finalReply = res1.ok ? res1.content : "Hey! I'll reply soon 🙏";
    track('photos').catch(() => {});
  }

  /* ─── COMPLEX: Council ─── */
  else if (isComplex) {
    console.log('[Anu] COUNCIL mode for:', userText.slice(0, 60));
    const sysPrompt = buildSystemPrompt(OWNER_NAME, firstName, history);

    const councilPromises = COUNCIL_MODELS.map(m => {
      const memberPrompt = `${sysPrompt}\n\n─── YOUR FOCUS ───\nAs the ${m.name.toUpperCase()} member, emphasize: ${m.focus}`;
      return callGroq(m.id, memberPrompt,
        [...convHistory, { role: 'user', content: userContent }],
        { maxTokens: 400, timeoutMs: 6000, temperature: 0.75 }
      ).then(r => ({ ...m, ...r }));
    });

    const councilResults = await Promise.all(councilPromises);
    const valid = councilResults.filter(r => r.ok && r.content);
    console.log('[Anu] Council:', valid.length, '/', COUNCIL_MODELS.length, 'succeeded');

    if (valid.length === 0) {
      finalReply = "Hey! I'll get back to you shortly 🙏";
    } else if (valid.length === 1) {
      finalReply = valid[0].content;
    } else {
      const synthInput = valid.map(r => `─── ${r.name} (${r.icon}) ───\n${r.content}`).join('\n\n');
      const coord = await callGroq(COORDINATOR_MODEL,
        COORDINATOR_PROMPT(OWNER_NAME, firstName),
        [{ role: 'user', content:
          `Original message from ${firstName}: "${userText}"\n\n` +
          `Council drafts:\n\n${synthInput}\n\n` +
          `Now produce ONE final reply as Anu:`
        }],
        { maxTokens: 500, timeoutMs: 5000, temperature: 0.5 }
      );
      finalReply = coord.ok ? coord.content : valid[0].content;
    }
    track('council').catch(() => {});
  }

  /* ─── SIMPLE: Fast single model ─── */
  else {
    console.log('[Anu] FAST mode for:', userText.slice(0, 60));
    const sysPrompt = buildSystemPrompt(OWNER_NAME, firstName, history);
    const res1 = await callGroq(FAST_MODEL, sysPrompt,
      [...convHistory, { role: 'user', content: userContent }],
      { maxTokens: 300, timeoutMs: 5000, temperature: 0.85 }
    );
    finalReply = res1.ok ? res1.content : "Hey! I'll reply soon 🙏";
    track('fast').catch(() => {});
  }

  /* ─── Sanity check ─── */
  if (!finalReply || finalReply.trim().length === 0) {
    finalReply = "Hey! I'll get back to you shortly 🙏";
  }
  if (finalReply.length > 4000) finalReply = finalReply.slice(0, 3900) + '…';

  /* ─── Human-like delay ─── */
  await new Promise(r => setTimeout(r, humanDelay(finalReply)));

  /* ─── Send reply ─── */
  const sendRes = await tg('sendMessage', {
    chat_id: chatId,
    text: finalReply,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  });

  if (sendRes && sendRes.ok) {
    console.log('[Anu] ✅ Reply sent to', firstName);
  }

  /* ─── Save history ─── */
  await saveHistory(chatId, userText || '[photo]', finalReply, firstName);

  /* ═══════════════════════════════════════
     ESCALATION TO OWNER
     ═══════════════════════════════════════ */
  const sentiment = detectSentiment(userText);
  const needsOwner = wantsOwner(userText);
  const shouldNotify = needsOwner || sentiment === 'urgent' || sentiment === 'angry';

  if (shouldNotify && OWNER_CHAT_ID) {
    let emoji = '🔔', label = 'Message';
    if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
    else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry sender'; }
    else if (needsOwner) { emoji = '📩'; label = 'Wants your attention'; }

    const notifyText =
      `${emoji} *${label}* from *${firstName}*\n\n` +
      `💬 _"${userText || '[photo]'}"_\n\n` +
      `🤖 Anu replied: _"${finalReply.slice(0, 200)}${finalReply.length > 200 ? '…' : ''}"_\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `↩️ *Reply to this message* to send your own reply as ${OWNER_NAME}.\n` +
      `━━━━━━━━━━━━━━━━━━━━━━`;

    const notif = await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text: notifyText,
      parse_mode: 'Markdown'
    });

    /* ─── Save pending reply slot for owner's reply ─── */
    if (notif && notif.ok && notif.result?.message_id) {
      await fsSet('bot_pending_replies', String(notif.result.message_id), {
        targetChatId: chatId,
        businessConnectionId: bizConnId,
        senderName: firstName,
        originalText: userText || '[photo]',
        createdAt: Date.now()
      });
      console.log('[Anu] ✅ Owner notified & reply slot saved');
    }

    await track('escalations').catch(() => {});
  }

  /* ─── After-hours notification ─── */
  if (!isBusinessHours() && OWNER_CHAT_ID) {
    await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text: `🌙 _After-hours message from ${firstName}: "${(userText || '[photo]').slice(0, 100)}"_`,
      parse_mode: 'Markdown'
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true });
}
