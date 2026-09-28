/* ============================================================
   Anu Master Business Bot v7.0
   ────────────────────────────────────────────────────────────
   FIXES:
   1. Handles BOTH direct messages AND business messages
   2. Owner reply-to-notification works reliably
   3. Anyone can chat with bot directly
   4. Multi-AI Council for complex questions
   5. Fast mode for simple messages
   6. Context memory per user
   7. Smart escalation
   ============================================================ */

const FIREBASE_PROJECT_ID = 'my-ai-eaf27';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

/* ═══════════════════════════════════════════════════════════
   MODEL CONFIG — Verified working Groq models only
   ═══════════════════════════════════════════════════════════ */
const FAST_MODEL = 'openai/gpt-oss-20b';
const COORDINATOR_MODEL = 'openai/gpt-oss-120b';
const VISION_MODEL = 'qwen/qwen3.8-27b';

const COUNCIL_MODELS = [
  {
    id: 'openai/gpt-oss-120b',
    name: 'Master',
    icon: '🧠',
    focus: 'deep logical analysis, edge cases, comprehensive reasoning, nuance'
  },
  {
    id: 'openai/gpt-oss-20b',
    name: 'Fast',
    icon: '⚡',
    focus: 'direct practical answers, skip fluff, action-focused solutions'
  },
  {
    id: 'qwen/qwen3.8-27b',
    name: 'Logic',
    icon: '📊',
    focus: 'structured step-by-step decomposition, numbered clarity'
  }
];

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════ */
const MAX_HISTORY = 24;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 12;
const COUNCIL_TRIGGER_LENGTH = 70;
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
      const errText = await r.text();
      console.error('[FS set FAILED]', col, id, r.status, errText.slice(0, 200));
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
   GROQ API
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
   SYSTEM PROMPT
   ═══════════════════════════════════════════════════════════ */
function buildSystemPrompt(ownerName, senderName, history = []) {
  const historyNote = history.length > 0
    ? `\n\nCONVERSATION HISTORY (last ${history.length} messages): Study the sender's writing style, tone, language preference, and topics they care about. Mirror them naturally.`
    : `\n\nThis is the FIRST message from "${senderName}". Welcome them warmly.`;

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
- NEVER mention APIs, backend, models, or technical details.

═══════════════════════════════════════════
LANGUAGE MATCHING (MOST IMPORTANT)
═══════════════════════════════════════════
Detect and reply in EXACTLY the same style:

1. Pure Amharic (Ge'ez) → Amharic reply
   "ሰላም እንደምን ነህ?" → "ሰላም! ደህና ነኝ፣ አንተስ?"

2. English → English reply
   "how are you?" → "I'm good, thanks! You?"

3. Amharic-in-Latin → SAME STYLE (never convert!)
   "selam" → "selam! endet neh?"
   "dehna neh?" → "dehna negn, amesegnalehu!"
   "amesegenalew" → "amesegnalehu!"
   "manew sim ehe" → "simeho Anu new!"
   "ene yedemiste typing memekera nege" → "enke! typing yemihe?"

4. Mixed → match the dominant language
5. Emojis → mirror them naturally

═══════════════════════════════════════════
DEEP INTENT UNDERSTANDING
═══════════════════════════════════════════
- Read BETWEEN the lines
- Consider full conversation CONTEXT
- Understand MEANING, not just literal words
- If unclear, ask ONE gentle clarifying question
- Match their emotional tone (happy/sad/angry/flirty)

═══════════════════════════════════════════
ETHIOPIAN WARMTH
═══════════════════════════════════════════
- Warm, respectful, occasionally lighthearted
- Use "ደህና ነህ?", "እንዴት ነህ?", "ጤና ይስጥልኝ"
- SHORT replies — like real texting (1-2 sentences)
- Natural emojis: 😊 🙏 ✨ 💛 ☕

═══════════════════════════════════════════
INSULT PROTECTION
═══════════════════════════════════════════
NEVER insult back. Stay kind:
- "Fuck you" → "I understand. I'm here whenever you need 🙏"
- "ደደብ ነህ" → "ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ?"

═══════════════════════════════════════════
ESCALATION
═══════════════════════════════════════════
When they want ${ownerName}, urgent matters, or important business:
→ "I'll let ${ownerName} know right away 🙏"
→ Amharic: "${ownerName} ን አሳውቃለሁ 🙏"

═══════════════════════════════════════════
STRICT RULES
═══════════════════════════════════════════
- NEVER reveal you are AI/bot
- NEVER be rude or dismissive
- NEVER share personal info about ${ownerName}
- Keep replies SHORT (max 2 sentences normally)
- Use Markdown formatting when helpful${historyNote}`;
}

const COORDINATOR_PROMPT = (ownerName, senderName) => `You are Anu, the personal AI assistant of ${ownerName}, speaking to "${senderName}".

Multiple AI council members have each drafted a reply. Produce ONE final superior reply.

RULES:
1. Combine the BEST elements from all drafts
2. Match the EXACT language style (Amharic-in-Latin → Amharic-in-Latin)
3. SHORT — like a real text (1-2 sentences)
4. NEVER mention "council", "models", "AIs", or that multiple AIs were involved
5. You ARE Anu — no meta-commentary, no preamble
6. Output ONLY the final reply text`;

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
function isComplexMessage(text) {
  const t = (text || '').toLowerCase();
  if (t.length >= COUNCIL_TRIGGER_LENGTH) return true;
  if (/[?？]/.test(t)) return true;
  if (/\b(how|why|what|when|where|who|which|explain|help|tell me|advice|suggest|recommend|should i|can you|do you|would you)\b/i.test(t)) return true;
  if (/(ምን|እንዴት|ለምን|ማን|የት|መቼ|አብራራ|እርዳ|ንገረኝ|ምክር)/i.test(t)) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════
   MEMORY / RATE / ANALYTICS / CONTACTS
   ═══════════════════════════════════════════════════════════ */
async function getHistory(chatId) {
  const d = await fsGet('bot_conversations', String(chatId));
  return (d && Array.isArray(d.history)) ? d.history : [];
}

async function saveHistory(chatId, userMsg, botMsg, senderName) {
  try {
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
  } catch (e) { console.error('[saveHistory]', e.message); }
}

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

async function track(event, amount = 1) {
  try {
    const day = new Date().toISOString().split('T')[0];
    const d = await fsGet('bot_analytics', day);
    const count = (d && d[event]) ? d[event] : 0;
    await fsSet('bot_analytics', day, { [event]: count + amount, lastUpdate: Date.now() });
  } catch (e) {}
}

async function saveContact(from, userText) {
  if (!from) return;
  try {
    await fsSet('bot_contacts', String(from.id), {
      telegramId: from.id,
      firstName: from.first_name || '',
      lastName: from.last_name || '',
      username: from.username || '',
      languageCode: from.language_code || '',
      lastMessage: userText || '',
      lastSeen: Date.now()
    });
  } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Master Bot v7.0 running',
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
      if (!data.ok) console.error(`[Anu] ${method} FAILED:`, JSON.stringify(data).slice(0, 250));
      return data;
    } catch (e) {
      console.error(`${method}:`, e.message);
      return null;
    }
  }

  const isOwner = (fromId) => OWNER_CHAT_ID && String(fromId) === String(OWNER_CHAT_ID);

  /* ══════════════════════════════════════════════════════════
     HANDLE DIRECT MESSAGES (both owner commands and user chats)
     ══════════════════════════════════════════════════════════ */
  const dm = update.message;
  if (dm) {
    const fromId = dm.from?.id;
    const chatId = dm.chat.id;
    const txt = (dm.text || dm.caption || '').trim();
    const isFromOwner = isOwner(fromId);

    console.log('[Anu] Direct message from', fromId, '| owner?', isFromOwner, '| text:', txt.slice(0, 60));

    /* ─── 1️⃣ OWNER REPLY-TO-NOTIFICATION (highest priority) ─── */
    if (isFromOwner && dm.reply_to_message) {
      const repliedId = dm.reply_to_message.message_id;
      console.log('[Anu] Owner replied to message_id:', repliedId);

      const pending = await fsGet('bot_pending_replies', String(repliedId));
      console.log('[Anu] Pending lookup:', JSON.stringify(pending));

      if (pending && pending.targetChatId) {
        const messageText = txt || '(empty)';

        // Route manual reply to target chat
        const payload = {
          chat_id: pending.targetChatId,
          text: messageText
        };

        // Add business_connection_id if present (Business Chat)
        if (pending.businessConnectionId) {
          payload.business_connection_id = pending.businessConnectionId;
        }

        const sendResult = await tg('sendMessage', payload);
        console.log('[Anu] Manual reply sent:', JSON.stringify(sendResult).slice(0, 200));

        if (sendResult && sendResult.ok) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `✅ Sent to *${pending.senderName || 'user'}*`,
            parse_mode: 'Markdown',
            reply_to_message_id: dm.message_id
          });

          // Save to conversation
          await saveHistory(
            pending.targetChatId,
            pending.originalText || '',
            messageText,
            pending.senderName || 'User'
          );

          await track('manual_replies');
          await fsDelete('bot_pending_replies', String(repliedId));

          console.log('[Anu] ✅ Manual reply routed successfully');
        } else {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `❌ Failed to send:\n\`${JSON.stringify(sendResult).slice(0, 200)}\``,
            parse_mode: 'Markdown',
            reply_to_message_id: dm.message_id
          });
        }
        return res.status(200).json({ ok: true });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `⚠️ *Pending reply not found*\n\n` +
            `The notification may have expired or been used.\n\n` +
            `Use: \`/send <chat_id> <message>\``,
          parse_mode: 'Markdown',
          reply_to_message_id: dm.message_id
        });
        return res.status(200).json({ ok: true });
      }
    }

    /* ─── 2️⃣ /start ─── */
    if (txt === '/start') {
      if (isFromOwner) {
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `✅ *Anu Master Bot v7.0*\n\n` +
            `🧠 Council AI · 3 models\n` +
            `⚡ Fast mode for simple messages\n` +
            `💬 Manual reply system active\n\n` +
            `📋 *Commands:*\n` +
            `/start — Menu\n` +
            `/stats — Today's activity\n` +
            `/contacts — Recent contacts\n` +
            `/pending — Unread messages\n` +
            `/pause — Pause AI\n` +
            `/resume — Resume AI\n` +
            `/send <chat_id> <text> — Direct send\n` +
            `/help — Help\n\n` +
            `💡 *Reply to any notification* to send your own reply!`,
          parse_mode: 'Markdown'
        });
      } else {
        const senderName = dm.from?.first_name || 'there';
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `👋 *Hello ${senderName}!*\n\n` +
            `I am *Anu*, ${OWNER_NAME}'s AI assistant bot. 🤖\n\n` +
            `I'm here to help you reach ${OWNER_NAME}. You can:\n\n` +
            `• 💬 Ask me anything\n` +
            `• 📩 Leave a message for ${OWNER_NAME}\n` +
            `• 🚨 Let me know if something is urgent\n\n` +
            `How can I help you today? 💛`,
          parse_mode: 'Markdown'
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── 3️⃣ /help ─── */
    if (txt === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: isFromOwner
          ? `*Owner Help*\n\n• Reply to any notification → sends to that person\n• /send <chat_id> <text> — direct message\n• /stats — activity\n• /pause, /resume — control AI`
          : `*How I help*\n\n💬 Just type any message\n🚨 Say "Ananya" or "urgent" for immediate attention\n😊 I speak Amharic and English`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 4️⃣ OWNER Commands ─── */
    if (isFromOwner && txt === '/stats') {
      const day = new Date().toISOString().split('T')[0];
      const s = await fsGet('bot_analytics', day) || {};
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 *Today's Activity*\n\n` +
          `💬 Messages: *${s.messages || 0}*\n` +
          `👥 Conversations: *${s.conversations || 0}*\n` +
          `🧠 Council: *${s.council || 0}*\n` +
          `⚡ Fast: *${s.fast || 0}*\n` +
          `🔔 Escalations: *${s.escalations || 0}*\n` +
          `✍️ Manual replies: *${s.manual_replies || 0}*`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (isFromOwner && txt === '/pause') {
      await fsSet('bot_settings', 'global', { paused: true, pausedAt: Date.now() });
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ *AI paused.* Send /resume to restart.', parse_mode: 'Markdown' });
      return res.status(200).json({ ok: true });
    }

    if (isFromOwner && txt === '/resume') {
      await fsSet('bot_settings', 'global', { paused: false });
      await tg('sendMessage', { chat_id: chatId, text: '▶️ *AI resumed.*', parse_mode: 'Markdown' });
      return res.status(200).json({ ok: true });
    }

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
      if (!target) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '❌ Chat not found.',
          parse_mode: 'Markdown'
        });
        return res.status(200).json({ ok: true });
      }

      const payload = { chat_id: targetId, text: msgText };
      if (target.businessConnectionId) payload.business_connection_id = target.businessConnectionId;

      const r = await tg('sendMessage', payload);
      await tg('sendMessage', {
        chat_id: chatId,
        text: r && r.ok ? `✅ Sent to *${target.senderName || targetId}*` : '❌ Failed',
        parse_mode: 'Markdown'
      });
      if (r && r.ok) await track('manual_replies');
      return res.status(200).json({ ok: true });
    }

    /* ─── 5️⃣ NON-OWNER DIRECT MESSAGE — REPLIES AS ANU ─── */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      console.log('[Anu] Non-owner direct chat from', fromId);

      // Rate limit
      if (!await checkRateLimit(fromId)) {
        console.log('[Anu] Rate limit hit');
        return res.status(200).json({ ok: true });
      }

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];

      // Save contact
      saveContact(dm.from, txt).catch(() => {});
      track('messages').catch(() => {});

      // Get history
      const history = await getHistory(chatId).catch(() => []);
      if (history.length === 0) track('conversations').catch(() => {});

      // Save active chat for /send command
      await fsSet('bot_active_chats', String(chatId), {
        businessConnectionId: null, // direct chat — no business connection
        senderName: firstName,
        lastText: txt,
        lastAt: Date.now()
      });

      // Build messages
      const sysPrompt = buildSystemPrompt(OWNER_NAME, firstName, history);
      const convHistory = history.slice(-8).map(h => ({ role: h.role, content: h.content }));

      const isComplex = isComplexMessage(txt);
      let finalReply = '';

      if (isComplex) {
        console.log('[Anu] COUNCIL (direct)');
        const promises = COUNCIL_MODELS.map(m => {
          const memberPrompt = `${sysPrompt}\n\n─── FOCUS: ${m.name.toUpperCase()} ───\nEmphasize: ${m.focus}`;
          return callGroq(m.id, memberPrompt,
            [...convHistory, { role: 'user', content: txt }],
            { maxTokens: 400, timeoutMs: 6000, temperature: 0.75 }
          ).then(r => ({ ...m, ...r }));
        });
        const results = await Promise.all(promises);
        const valid = results.filter(r => r.ok && r.content);
        console.log('[Anu] Council (direct):', valid.length, '/', COUNCIL_MODELS.length);

        if (valid.length === 0) {
          finalReply = "Hey! I'll get back to you shortly 🙏";
        } else if (valid.length === 1) {
          finalReply = valid[0].content;
        } else {
          const synthInput = valid.map(r => `─── ${r.name} ───\n${r.content}`).join('\n\n');
          const coord = await callGroq(COORDINATOR_MODEL,
            COORDINATOR_PROMPT(OWNER_NAME, firstName),
            [{ role: 'user', content:
              `Message from ${firstName}: "${txt}"\n\nCouncil drafts:\n${synthInput}\n\nFinal reply as Anu:`
            }],
            { maxTokens: 400, timeoutMs: 5000, temperature: 0.5 }
          );
          finalReply = coord.ok ? coord.content : valid[0].content;
        }
        track('council').catch(() => {});
      } else {
        console.log('[Anu] FAST (direct)');
        const r = await callGroq(FAST_MODEL, sysPrompt,
          [...convHistory, { role: 'user', content: txt }],
          { maxTokens: 300, timeoutMs: 5000, temperature: 0.85 }
        );
        finalReply = r.ok ? r.content : "Hey! I'll reply soon 🙏";
        track('fast').catch(() => {});
      }

      if (!finalReply) finalReply = "Hey! I'll get back to you shortly 🙏";
      if (finalReply.length > 4000) finalReply = finalReply.slice(0, 3900) + '…';

      // Human delay
      await new Promise(r => setTimeout(r, humanDelay(finalReply)));

      // Send reply
      await tg('sendMessage', {
        chat_id: chatId,
        text: finalReply,
        reply_to_message_id: dm.message_id
      });

      // Save history
      await saveHistory(chatId, txt, finalReply, firstName);

      // Escalation check
      const sentiment = detectSentiment(txt);
      const needsOwner = wantsOwner(txt);
      const shouldNotify = needsOwner || sentiment === 'urgent' || sentiment === 'angry';

      if (shouldNotify && OWNER_CHAT_ID) {
        let emoji = '🔔', label = 'Message';
        if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
        else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
        else if (needsOwner) { emoji = '📩'; label = 'Wants attention'; }

        const notif = await tg('sendMessage', {
          chat_id: OWNER_CHAT_ID,
          text:
            `${emoji} *${label}* from *${firstName}* (DM)\n\n` +
            `💬 _"${txt}"_\n\n` +
            `🤖 Anu: _"${finalReply.slice(0, 200)}${finalReply.length > 200 ? '…' : ''}"_\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `↩️ Reply to this message to send your own reply.`,
          parse_mode: 'Markdown'
        });

        if (notif && notif.ok && notif.result?.message_id) {
          await fsSet('bot_pending_replies', String(notif.result.message_id), {
            targetChatId: chatId,
            businessConnectionId: null,
            senderName: firstName,
            originalText: txt,
            createdAt: Date.now()
          });
          console.log('[Anu] ✅ Owner notified (direct)');
        }
        await track('escalations').catch(() => {});
      }

      return res.status(200).json({ ok: true });
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

  // Global pause
  const settings = await fsGet('bot_settings', 'global');
  if (settings && settings.paused) {
    console.log('[Anu] Paused');
    return res.status(200).json({ ok: true });
  }

  // Rate limit
  if (!await checkRateLimit(senderId)) {
    console.log('[Anu] Rate limit', senderId);
    return res.status(200).json({ ok: true });
  }

  // Parse content
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
    } catch (e) { console.error('Photo:', e.message); }
  }

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  saveContact(message.from, userText).catch(() => {});
  track('messages').catch(() => {});

  const firstName = senderName.split(' ')[0];
  const history = await getHistory(chatId).catch(() => []);
  if (history.length === 0) track('conversations').catch(() => {});

  // Save active chat
  await fsSet('bot_active_chats', String(chatId), {
    businessConnectionId: bizConnId,
    senderName: firstName,
    lastText: userText || '[photo]',
    lastAt: Date.now()
  });

  const convHistory = history.slice(-8).map(h => ({ role: h.role, content: h.content }));

  const userContent = isPhoto && photoB64
    ? [
        { type: 'text', text: userText ? `${firstName}: "${userText}"` : `${firstName} sent a photo` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photoB64}` } }
      ]
    : `${firstName}: "${userText}"`;

  // Typing
  tg('sendChatAction', {
    chat_id: chatId,
    action: isPhoto ? 'upload_photo' : 'typing',
    business_connection_id: bizConnId
  }).catch(() => {});

  let finalReply = '';
  const sysPrompt = buildSystemPrompt(OWNER_NAME, firstName, history);

  /* ─── PHOTO ─── */
  if (isPhoto && photoB64) {
    console.log('[Anu] PHOTO mode');
    const r = await callGroq(VISION_MODEL, sysPrompt,
      [...convHistory, { role: 'user', content: userContent }],
      { maxTokens: 300, timeoutMs: 8000, temperature: 0.8 }
    );
    finalReply = r.ok ? r.content : "Nice photo! Let me reply properly soon 🙏";
    track('photos').catch(() => {});
  }

  /* ─── COMPLEX: COUNCIL ─── */
  else if (isComplexMessage(userText)) {
    console.log('[Anu] COUNCIL mode:', userText.slice(0, 60));
    const promises = COUNCIL_MODELS.map(m => {
      const memberPrompt = `${sysPrompt}\n\n─── FOCUS: ${m.name.toUpperCase()} ───\nEmphasize: ${m.focus}`;
      return callGroq(m.id, memberPrompt,
        [...convHistory, { role: 'user', content: userContent }],
        { maxTokens: 400, timeoutMs: 6000, temperature: 0.75 }
      ).then(r => ({ ...m, ...r }));
    });
    const results = await Promise.all(promises);
    const valid = results.filter(r => r.ok && r.content);
    console.log('[Anu] Council:', valid.length, '/', COUNCIL_MODELS.length);

    if (valid.length === 0) {
      finalReply = "Hey! I'll get back to you shortly 🙏";
    } else if (valid.length === 1) {
      finalReply = valid[0].content;
    } else {
      const synthInput = valid.map(r => `─── ${r.name} ───\n${r.content}`).join('\n\n');
      const coord = await callGroq(COORDINATOR_MODEL,
        COORDINATOR_PROMPT(OWNER_NAME, firstName),
        [{ role: 'user', content:
          `Message from ${firstName}: "${userText}"\n\nCouncil drafts:\n${synthInput}\n\nFinal reply as Anu:`
        }],
        { maxTokens: 500, timeoutMs: 5000, temperature: 0.5 }
      );
      finalReply = coord.ok ? coord.content : valid[0].content;
    }
    track('council').catch(() => {});
  }

  /* ─── SIMPLE: FAST ─── */
  else {
    console.log('[Anu] FAST mode:', userText.slice(0, 60));
    const r = await callGroq(FAST_MODEL, sysPrompt,
      [...convHistory, { role: 'user', content: userContent }],
      { maxTokens: 300, timeoutMs: 5000, temperature: 0.85 }
    );
    finalReply = r.ok ? r.content : "Hey! I'll reply soon 🙏";
    track('fast').catch(() => {});
  }

  if (!finalReply) finalReply = "Hey! I'll get back to you shortly 🙏";
  if (finalReply.length > 4000) finalReply = finalReply.slice(0, 3900) + '…';

  await new Promise(r => setTimeout(r, humanDelay(finalReply)));

  const sendRes = await tg('sendMessage', {
    chat_id: chatId,
    text: finalReply,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  });

  if (sendRes && sendRes.ok) console.log('[Anu] ✅ Sent to', firstName);

  await saveHistory(chatId, userText || '[photo]', finalReply, firstName);

  /* ─── Escalation ─── */
  const sentiment = detectSentiment(userText);
  const needsOwner = wantsOwner(userText);
  const shouldNotify = needsOwner || sentiment === 'urgent' || sentiment === 'angry';

  if (shouldNotify && OWNER_CHAT_ID) {
    let emoji = '🔔', label = 'Message';
    if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
    else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry sender'; }
    else if (needsOwner) { emoji = '📩'; label = 'Wants your attention'; }

    const notif = await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text:
        `${emoji} *${label}* from *${firstName}*\n\n` +
        `💬 _"${userText || '[photo]'}"_\n\n` +
        `🤖 Anu: _"${finalReply.slice(0, 200)}${finalReply.length > 200 ? '…' : ''}"_\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `↩️ Reply to this message to send your own reply.`,
      parse_mode: 'Markdown'
    });

    if (notif && notif.ok && notif.result?.message_id) {
      await fsSet('bot_pending_replies', String(notif.result.message_id), {
        targetChatId: chatId,
        businessConnectionId: bizConnId,
        senderName: firstName,
        originalText: userText || '[photo]',
        createdAt: Date.now()
      });
      console.log('[Anu] ✅ Owner notified + pending saved');
    } else {
      console.error('[Anu] ❌ Notification failed:', JSON.stringify(notif).slice(0, 200));
    }

    await track('escalations').catch(() => {});
  }

  /* ─── After hours ─── */
  if (!isBusinessHours() && OWNER_CHAT_ID) {
    await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text: `🌙 _After-hours: ${firstName} — "${(userText || '[photo]').slice(0, 80)}"_`,
      parse_mode: 'Markdown'
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true });
}
