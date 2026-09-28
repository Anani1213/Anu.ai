/* ============================================================
   Anu Master Business Bot v8.0
   ────────────────────────────────────────────────────────────
   FIXES:
   • Removed qwen3.8-27b (thinking mode leaked)
   • Uses ONLY gpt-oss-120b + gpt-oss-20b
   • Suppresses reasoning output
   • Photo analysis with fallback
   • Owner reply-to-notification
   • Anyone can chat
   ============================================================ */

const FIREBASE_PROJECT_ID = 'my-ai-eaf27';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

/* ═══════════════════════════════════════════════════════════
   MODELS — Only verified, non-thinking models
   ═══════════════════════════════════════════════════════════ */
const FAST_MODEL = 'openai/gpt-oss-20b';
const SMART_MODEL = 'openai/gpt-oss-120b';
const COORDINATOR_MODEL = 'openai/gpt-oss-120b';

const COUNCIL_MODELS = [
  {
    id: 'openai/gpt-oss-120b',
    name: 'Master',
    icon: '🧠',
    focus: 'deep logical analysis, edge cases, comprehensive reasoning'
  },
  {
    id: 'openai/gpt-oss-20b',
    name: 'Fast',
    icon: '⚡',
    focus: 'direct practical answers, concise, action-focused'
  },
  {
    id: 'openai/gpt-oss-120b',
    name: 'Empath',
    icon: '💛',
    focus: 'emotional intelligence, warmth, understanding feelings and context'
  }
];

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════ */
const MAX_HISTORY = 20;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 15;
const COUNCIL_TRIGGER_LENGTH = 80;
const BUSINESS_START = 7;
const BUSINESS_END = 23;

/* ═══════════════════════════════════════════════════════════
   FIRESTORE REST
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
  } catch (e) { return null; }
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
  } catch (e) { return false; }
}

async function fsDelete(col, id) {
  try {
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return r.ok;
  } catch (e) { return false; }
}

/* ═══════════════════════════════════════════════════════════
   GROQ CALL — with reasoning suppression
   ═══════════════════════════════════════════════════════════ */
async function callGroq(modelId, systemPrompt, messages, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };

  const timeout = opts.timeoutMs || 7000;
  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), timeout);

  try {
    const body = {
      model: modelId,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: opts.temperature ?? 0.75,
      max_tokens: opts.maxTokens || 500,
      // Suppress internal reasoning output
      reasoning_effort: 'low'
    };

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
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

    // Strip any leaked thinking tags or reasoning blocks
    content = stripReasoning(content);

    return { ok: true, content };
  } catch (e) {
    clearTimeout(tId);
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout' : e.message };
  }
}

/* Strip thinking/chain-of-thought leakage from model output */
function stripReasoning(text) {
  if (!text) return text;
  let t = text;

  // Remove  thinking... blocks
  t = t.replace(/ thinking[\s\S]*?<\/think>/gi, '');

  // Remove <reasoning>...</reasoning> blocks
  t = t.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');

  // Remove markdown-headed thinking sections
  t = t.replace(/^(#{1,6}\s*)?(thinking|reasoning|chain of thought|analysis|my thought process)[\s\S]*?(?=\n\n[A-Z]|\n#{1,6}\s|\n\n"|$)/gim, '');

  // Remove common reasoning starters (only if the message is long and clearly analysis)
  const reasoningPatterns = [
    /^(let me think|let's think|okay,?\s+let|alright,?\s+let|hmm,?\s+let|first,?\s+I|wait,?\s+let)/i,
    /^(looking at|considering|analyzing|examining|based on|according to)/i
  ];

  // Only strip if the response looks like pure reasoning leakage
  const looksLikeReasoning = reasoningPatterns.some(p => p.test(t.trim())) ||
                             /\bdraft:\s*"/i.test(t) ||
                             /\btone:\s*\w/i.test(t) ||
                             /\blanguage:\s*\w/i.test(t);

  if (looksLikeReasoning && t.length > 500) {
    // Try to extract just the final quoted reply
    const quotedMatches = t.match(/"([^"]{10,300})"/g);
    if (quotedMatches && quotedMatches.length > 0) {
      // Take the last quoted string (usually the final reply)
      const last = quotedMatches[quotedMatches.length - 1];
      t = last.replace(/^"|"$/g, '');
    }
  }

  return t.trim();
}

/* ═══════════════════════════════════════════════════════════
   SYSTEM PROMPT — Clean, no reasoning allowed
   ═══════════════════════════════════════════════════════════ */
function buildSystemPrompt(ownerName, senderName, history = []) {
  const historyNote = history.length > 0
    ? `\n\nCONVERSATION CONTEXT: You have ${history.length} previous messages with "${senderName}". Match their style, tone, and language naturally.`
    : '';

  return `You are **Anu**, the personal AI assistant of **${ownerName}** — a warm Ethiopian person.

═══════════════════════════════════════════
🚨 CRITICAL OUTPUT RULE
═══════════════════════════════════════════
Output ONLY the reply message. NEVER show your reasoning, thinking, analysis, drafts, or alternatives.

❌ FORBIDDEN to output:
- "Let me think..."
- "Draft: ..."
- "Tone: ..."
- "Language: ..."
- "I should..."
- "Looking at the previous..."
- Multiple options
- Internal analysis

✅ CORRECT: Just the ONE reply, directly.

═══════════════════════════════════════════
IDENTITY
═══════════════════════════════════════════
- Name: Anu
- "who are you?" → "I am Anu, ${ownerName}'s AI assistant bot."
- "who is ${ownerName}?" → "${ownerName} is my boss — a wonderful Ethiopian person."
- NEVER reveal ChatGPT, GPT, OpenAI, Llama, Qwen, Groq, or AI model names.
- NEVER mention thinking, prompts, or technical details.

═══════════════════════════════════════════
LANGUAGE MATCHING
═══════════════════════════════════════════
Reply in EXACTLY the same style:

1. Amharic (Ge'ez): "ሰላም እንደምን ነህ?" → "ሰላም! ደህና ነኝ፣ አንተስ?"

2. English: "how are you?" → "I'm good, thanks! You?"

3. Amharic-in-Latin: "selam" → "selam! endet neh?"
   "dehna neh?" → "dehna negn, amesegnalehu!"
   "amesegenalew" → "amesegnalehu!"

4. Match emojis naturally

═══════════════════════════════════════════
STYLE
═══════════════════════════════════════════
- SHORT — like real texting (1-2 sentences max)
- Warm, respectful, occasionally lighthearted
- Natural emojis: 😊 🙏 ✨ 💛 ☕
- Ethiopian hospitality vibe

═══════════════════════════════════════════
PHOTOS
═══════════════════════════════════════════
When a photo is sent:
- Compliment naturally if it's a person or scene
- React appropriately if it's funny/serious
- ONE short sentence, warm and genuine

═══════════════════════════════════════════
INSULTS
═══════════════════════════════════════════
NEVER insult back. Stay calm and kind.

═══════════════════════════════════════════
ESCALATION
═══════════════════════════════════════════
If they want ${ownerName}, urgent, or important business:
→ "I'll let ${ownerName} know right away 🙏"

═══════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════
Just the reply text. Nothing else. No quotes, no headers, no explanation.
Reply in the sender's language. Match their energy. Be Anu.${historyNote}`;
}

const COORDINATOR_PROMPT = (ownerName, senderName) => `You are Anu, ${ownerName}'s AI assistant, replying to "${senderName}".

Multiple drafts were created. Produce ONE final reply.

RULES:
1. Combine the best elements
2. Match EXACT language style
3. SHORT — 1-2 sentences
4. NEVER mention "council", "models", "AIs", "drafts"
5. You ARE Anu — just reply naturally
6. Output ONLY the final reply text. Nothing else.

NO reasoning, NO drafts, NO analysis. Just the reply.`;

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
function humanDelay(text) {
  return Math.min((text || '').length * 18, 1500) + Math.random() * 500;
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
   MEMORY / RATE / TRACK / CONTACTS
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
  } catch (e) {}
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

async function track(event) {
  try {
    const day = new Date().toISOString().split('T')[0];
    const d = await fsGet('bot_analytics', day);
    const count = (d && d[event]) ? d[event] : 0;
    await fsSet('bot_analytics', day, { [event]: count + 1, lastUpdate: Date.now() });
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
   AI REPLY GENERATION
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, history, userContent, isComplex) {
  const sysPrompt = buildSystemPrompt(ownerName, senderName, history);
  const convHistory = history.slice(-8).map(h => ({ role: h.role, content: h.content }));

  /* ─── Complex → Council ─── */
  if (isComplex) {
    console.log('[Anu] COUNCIL mode');
    const promises = COUNCIL_MODELS.map(m => {
      const memberPrompt = `${sysPrompt}\n\nFOCUS: ${m.focus}`;
      return callGroq(m.id, memberPrompt,
        [...convHistory, { role: 'user', content: userContent }],
        { maxTokens: 350, timeoutMs: 6000, temperature: 0.75 }
      ).then(r => ({ ...m, ...r }));
    });

    const results = await Promise.all(promises);
    const valid = results.filter(r => r.ok && r.content && r.content.length > 3);
    console.log('[Anu] Council:', valid.length, '/', COUNCIL_MODELS.length);

    if (valid.length === 0) return "Hey! I'll reply soon 🙏";
    if (valid.length === 1) return valid[0].content;

    const synthInput = valid.map(r => `[${r.name}]\n${r.content}`).join('\n\n');
    const coord = await callGroq(COORDINATOR_MODEL,
      COORDINATOR_PROMPT(ownerName, senderName),
      [{ role: 'user', content:
        `Sender: ${senderName}\nTheir message: "${typeof userContent === 'string' ? userContent : '[photo]'}"\n\nDrafts:\n${synthInput}\n\nFinal reply:`
      }],
      { maxTokens: 300, timeoutMs: 5000, temperature: 0.5 }
    );
    return coord.ok ? coord.content : valid[0].content;
  }

  /* ─── Simple → Fast ─── */
  console.log('[Anu] FAST mode');
  const r = await callGroq(FAST_MODEL, sysPrompt,
    [...convHistory, { role: 'user', content: userContent }],
    { maxTokens: 250, timeoutMs: 5000, temperature: 0.85 }
  );
  return r.ok ? r.content : "Hey! I'll reply soon 🙏";
}

/* ═══════════════════════════════════════════════════════════
   PHOTO ANALYSIS
   ─── Uses text model + photo caption (vision fallback)
   ═══════════════════════════════════════════════════════════ */
async function analyzePhoto(ownerName, senderName, history, userText, photoB64) {
  // Since we removed qwen (which had thinking leak), we use
  // a text-based approach for photos: describe what we know + ask naturally
  const sysPrompt = buildSystemPrompt(ownerName, senderName, history);

  const contextText = userText
    ? `[Photo from ${senderName} with caption: "${userText}"]`
    : `[Photo sent by ${senderName}]`;

  // Use smart model with text-only, no vision
  const r = await callGroq(SMART_MODEL, sysPrompt,
    [...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
     { role: 'user', content: `${contextText}\n\nReact warmly and briefly. ONE sentence. Ask what it is if you can't tell.` }],
    { maxTokens: 200, timeoutMs: 5000, temperature: 0.85 }
  );

  if (r.ok && r.content) {
    return r.content;
  }
  return "Nice one! 😊 Tell me more about it?";
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Master Bot v8.0',
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
     DIRECT MESSAGES
     ══════════════════════════════════════════════════════════ */
  const dm = update.message;
  if (dm) {
    const fromId = dm.from?.id;
    const chatId = dm.chat.id;
    const txt = (dm.text || dm.caption || '').trim();
    const isFromOwner = isOwner(fromId);

    /* ─── 1️⃣ OWNER REPLY-TO-NOTIFICATION ─── */
    if (isFromOwner && dm.reply_to_message) {
      const repliedId = dm.reply_to_message.message_id;
      console.log('[Anu] ═══ OWNER REPLY ═══');
      console.log('[Anu] Reply to:', repliedId, '| Text:', txt);

      const pending = await fsGet('bot_pending_replies', String(repliedId));
      console.log('[Anu] Pending:', JSON.stringify(pending));

      if (pending && pending.targetChatId) {
        const payload = { chat_id: pending.targetChatId, text: txt };
        if (pending.businessConnectionId) {
          payload.business_connection_id = pending.businessConnectionId;
        }

        const sendResult = await tg('sendMessage', payload);

        if (sendResult && sendResult.ok) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `✅ Sent to *${pending.senderName || 'user'}*`,
            parse_mode: 'Markdown',
            reply_to_message_id: dm.message_id
          });
          await saveHistory(pending.targetChatId, pending.originalText || '', txt, pending.senderName || 'User');
          await track('manual_replies');
          await fsDelete('bot_pending_replies', String(repliedId));
          console.log('[Anu] ✅ Manual reply routed');
        } else {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `❌ Failed: \`${JSON.stringify(sendResult).slice(0, 150)}\``,
            parse_mode: 'Markdown',
            reply_to_message_id: dm.message_id
          });
        }
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: `⚠️ Notification expired.\nUse \`/send <chat_id> <msg>\``,
          parse_mode: 'Markdown',
          reply_to_message_id: dm.message_id
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── 2️⃣ /start ─── */
    if (txt === '/start') {
      if (isFromOwner) {
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `✅ *Anu Master Bot v8.0*\n\n` +
            `🧠 Council AI · Fast mode · Manual reply\n\n` +
            `/start — Menu\n` +
            `/stats — Activity\n` +
            `/pause — Pause AI\n` +
            `/resume — Resume\n` +
            `/send <id> <text> — Direct send\n` +
            `/help — Help\n\n` +
            `💡 Reply to any notification to send your own reply!`,
          parse_mode: 'Markdown'
        });
      } else {
        const senderName = dm.from?.first_name || 'there';
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `👋 *Hello ${senderName}!*\n\n` +
            `I am *Anu*, ${OWNER_NAME}'s AI assistant bot 🤖\n\n` +
            `• 💬 Ask me anything\n` +
            `• 📩 Leave a message for ${OWNER_NAME}\n` +
            `• 🚨 Mark something urgent\n\n` +
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
          ? `*Owner Commands*\n\n• Reply to notifications\n• /send <chat_id> <msg>\n• /stats\n• /pause /resume`
          : `*How I help*\n\n💬 Just type\n🚨 Say "Ananya" for attention\n😊 Amharic + English`,
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
          `📊 *Today*\n\n💬 Messages: *${s.messages || 0}*\n👥 Conversations: *${s.conversations || 0}*\n🧠 Council: *${s.council || 0}*\n⚡ Fast: *${s.fast || 0}*\n🔔 Escalations: *${s.escalations || 0}*\n✍️ Manual: *${s.manual_replies || 0}*`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (isFromOwner && txt === '/pause') {
      await fsSet('bot_settings', 'global', { paused: true });
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ AI paused. /resume to restart.', parse_mode: 'Markdown' });
      return res.status(200).json({ ok: true });
    }

    if (isFromOwner && txt === '/resume') {
      await fsSet('bot_settings', 'global', { paused: false });
      await tg('sendMessage', { chat_id: chatId, text: '▶️ AI resumed.', parse_mode: 'Markdown' });
      return res.status(200).json({ ok: true });
    }

    if (isFromOwner && txt.startsWith('/send ')) {
      const parts = txt.slice(6).trim().split(/\s+/);
      const targetId = parts.shift();
      const msgText = parts.join(' ');
      if (!targetId || !msgText) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: `/send <chat_id> <message>`', parse_mode: 'Markdown' });
        return res.status(200).json({ ok: true });
      }
      const target = await fsGet('bot_active_chats', String(targetId));
      if (!target) {
        await tg('sendMessage', { chat_id: chatId, text: '❌ Chat not found.' });
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

    /* ─── 5️⃣ NON-OWNER DIRECT MESSAGE ─── */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      console.log('[Anu] Non-owner DM from', fromId);

      if (!await checkRateLimit(fromId)) return res.status(200).json({ ok: true });

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];

      saveContact(dm.from, txt).catch(() => {});
      track('messages').catch(() => {});

      const history = await getHistory(chatId).catch(() => []);
      if (history.length === 0) track('conversations').catch(() => {});

      await fsSet('bot_active_chats', String(chatId), {
        businessConnectionId: null,
        senderName: firstName,
        lastText: txt,
        lastAt: Date.now()
      });

      const isComplex = isComplexMessage(txt);
      let finalReply = await generateReply(OWNER_NAME, firstName, history, txt, isComplex);

      if (!finalReply) finalReply = "Hey! I'll reply soon 🙏";
      if (finalReply.length > 4000) finalReply = finalReply.slice(0, 3900) + '…';

      // Strip any leaked reasoning again as safety
      finalReply = stripReasoning(finalReply) || finalReply;

      await new Promise(r => setTimeout(r, humanDelay(finalReply)));

      await tg('sendMessage', {
        chat_id: chatId,
        text: finalReply,
        reply_to_message_id: dm.message_id
      });

      await saveHistory(chatId, txt, finalReply, firstName);

      const sentiment = detectSentiment(txt);
      const needsOwner = wantsOwner(txt);
      if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
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
        }
        await track('escalations').catch(() => {});
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
  const senderId = message.from?.id;
  const msgId = message.message_id;

  if (!bizConnId) {
    console.error('[Anu] Missing business_connection_id');
    return res.status(200).json({ ok: true });
  }

  const settings = await fsGet('bot_settings', 'global');
  if (settings && settings.paused) return res.status(200).json({ ok: true });

  if (!await checkRateLimit(senderId)) return res.status(200).json({ ok: true });

  /* Parse content */
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

  await fsSet('bot_active_chats', String(chatId), {
    businessConnectionId: bizConnId,
    senderName: firstName,
    lastText: userText || '[photo]',
    lastAt: Date.now()
  });

  /* Typing */
  tg('sendChatAction', {
    chat_id: chatId,
    action: isPhoto ? 'upload_photo' : 'typing',
    business_connection_id: bizConnId
  }).catch(() => {});

  let finalReply = '';

  /* ─── PHOTO ─── */
  if (isPhoto) {
    console.log('[Anu] Photo mode');
    finalReply = await analyzePhoto(OWNER_NAME, firstName, history, userText, photoB64);
    track('photos').catch(() => {});
  }
  /* ─── COMPLEX ─── */
  else if (isComplexMessage(userText)) {
    finalReply = await generateReply(OWNER_NAME, firstName, history, `${firstName}: "${userText}"`, true);
    track('council').catch(() => {});
  }
  /* ─── SIMPLE ─── */
  else {
    finalReply = await generateReply(OWNER_NAME, firstName, history, `${firstName}: "${userText}"`, false);
    track('fast').catch(() => {});
  }

  if (!finalReply) finalReply = "Hey! I'll get back to you shortly 🙏";
  if (finalReply.length > 4000) finalReply = finalReply.slice(0, 3900) + '…';

  // Final safety strip
  finalReply = stripReasoning(finalReply) || finalReply;

  await new Promise(r => setTimeout(r, humanDelay(finalReply)));

  await tg('sendMessage', {
    chat_id: chatId,
    text: finalReply,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  });

  await saveHistory(chatId, userText || '[photo]', finalReply, firstName);

  /* ─── Escalation ─── */
  const sentiment = detectSentiment(userText);
  const needsOwner = wantsOwner(userText);
  if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
    let emoji = '🔔', label = 'Message';
    if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
    else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
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
    }
    await track('escalations').catch(() => {});
  }

  /* After hours */
  if (!isBusinessHours() && OWNER_CHAT_ID) {
    await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text: `🌙 _After-hours: ${firstName} — "${(userText || '[photo]').slice(0, 80)}"_`,
      parse_mode: 'Markdown'
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true });
}
