/* ============================================================
   Anu AI — Master Business Bot v5.0
   ────────────────────────────────────────────────────────────
   Ethiopian personality · Amharic/English · Photo analysis
   Context memory · Rate limiting · Human delay · Analytics
   Auto-escalation · Contact saving · Business hours
   ============================================================ */

import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, increment,
  collection, addDoc, serverTimestamp, query, where,
  getDocs, orderBy, limit
} from 'firebase/firestore';

/* ────────────────────────────────────────────────────────────
   FIREBASE
   ──────────────────────────────────────────────────────────── */
const firebaseConfig = {
  apiKey: "AIzaSyCdj7phsUGD-PeRwU3FqFITnfMY84sGRMQ",
  authDomain: "my-ai-eaf27.firebaseapp.com",
  projectId: "my-ai-eaf27",
  storageBucket: "my-ai-eaf27.firebasestorage.app",
  messagingSenderId: "604169434635",
  appId: "1:604169434635:web:ee0842670514647051790e"
};

let _db = null;
function getDB() {
  if (!_db) {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    _db = getFirestore(app);
  }
  return _db;
}

/* ────────────────────────────────────────────────────────────
   CONSTANTS
   ──────────────────────────────────────────────────────────── */
const GROQ_TEXT_MODEL = 'openai/gpt-oss-120b';
const GROQ_VISION_MODEL = 'qwen/qwen3.6-27b';
const MAX_HISTORY = 20;
const RATE_LIMIT_WINDOW = 60000;   // 1 ደቂቃ
const RATE_LIMIT_MAX = 15;         // 15 መልእክት/ደቂቃ
const BUSINESS_START = 7;
const BUSINESS_END = 23;

/* ────────────────────────────────────────────────────────────
   SYSTEM PROMPT
   ──────────────────────────────────────────────────────────── */
function buildSystemPrompt(ownerName = 'Ananya') {
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
ESCALATION
═══════════════════════════════════════════
If sender wants to reach ${ownerName}, has important business, or urgent matters:
→ "Let me check with ${ownerName} and get back to you 🙏"
→ Amharic: "${ownerName} ን ጠይቄ እነግርሃለሁ።"
→ "I'll pass this to ${ownerName} right away."

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

/* ────────────────────────────────────────────────────────────
   FIRESTORE HELPERS
   ──────────────────────────────────────────────────────────── */
async function fsGet(collectionName, docId) {
  try {
    const ref = doc(getDB(), collectionName, String(docId));
    const snap = await getDoc(ref);
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    console.error('[FS] get error:', e.message);
    return null;
  }
}

async function fsSet(collectionName, docId, data, merge = true) {
  try {
    const ref = doc(getDB(), collectionName, String(docId));
    await setDoc(ref, data, { merge });
    return true;
  } catch (e) {
    console.error('[FS] set error:', e.message);
    return false;
  }
}

async function fsAdd(collectionName, data) {
  try {
    const ref = collection(getDB(), collectionName);
    await addDoc(ref, { ...data, createdAt: Date.now() });
    return true;
  } catch (e) {
    console.error('[FS] add error:', e.message);
    return false;
  }
}

/* ────────────────────────────────────────────────────────────
   CONTEXT MEMORY
   ──────────────────────────────────────────────────────────── */
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
    const trimmed = updated.slice(-MAX_HISTORY);

    await fsSet('bot_conversations', chatId, {
      history: trimmed,
      senderName,
      lastMessage: userMsg || '',
      updatedAt: Date.now(),
      messageCount: increment(1)
    });
  } catch (e) {
    console.error('[Memory] save error:', e.message);
  }
}

/* ────────────────────────────────────────────────────────────
   RATE LIMITING
   ──────────────────────────────────────────────────────────── */
async function checkRateLimit(userId) {
  const docId = String(userId);
  const now = Date.now();

  try {
    const data = await fsGet('bot_ratelimits', docId);
    const timestamps = (data && Array.isArray(data.timestamps)) ? data.timestamps : [];
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);

    if (recent.length >= RATE_LIMIT_MAX) {
      return { allowed: false, remaining: 0 };
    }

    recent.push(now);
    await fsSet('bot_ratelimits', docId, { timestamps: recent });
    return { allowed: true, remaining: RATE_LIMIT_MAX - recent.length };
  } catch (e) {
    return { allowed: true, remaining: RATE_LIMIT_MAX };
  }
}

/* ────────────────────────────────────────────────────────────
   ANALYTICS
   ──────────────────────────────────────────────────────────── */
async function trackAnalytics(event, metadata = {}) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const ref = doc(getDB(), 'bot_analytics', today);
    await setDoc(ref, {
      [event]: increment(1),
      lastUpdate: Date.now(),
      ...metadata
    }, { merge: true });
  } catch (e) {
    console.error('[Analytics] error:', e.message);
  }
}

/* ────────────────────────────────────────────────────────────
   CONTACTS
   ──────────────────────────────────────────────────────────── */
async function saveContact(from, userText) {
  try {
    await fsSet('bot_contacts', String(from.id), {
      telegramId: from.id,
      firstName: from.first_name || '',
      lastName: from.last_name || '',
      username: from.username || '',
      languageCode: from.language_code || 'en',
      isPremium: from.is_premium || false,
      lastMessage: userText || '',
      lastSeen: Date.now()
    });
  } catch (e) {
    console.error('[Contacts] error:', e.message);
  }
}

/* ────────────────────────────────────────────────────────────
   HUMAN DELAY
   ──────────────────────────────────────────────────────────── */
function humanDelay(text) {
  const baseDelay = Math.min((text || '').length * 25, 2500);
  const jitter = Math.random() * 800;
  return baseDelay + jitter;
}

/* ────────────────────────────────────────────────────────────
   BUSINESS HOURS
   ──────────────────────────────────────────────────────────── */
function isBusinessHours() {
  const hour = new Date().getHours();
  return hour >= BUSINESS_START && hour < BUSINESS_END;
}

/* ────────────────────────────────────────────────────────────
   SENTIMENT DETECTION
   ──────────────────────────────────────────────────────────── */
function detectSentiment(text) {
  const t = (text || '').toLowerCase();
  const angry = /angry|upset|furious|mad|hate|stupid|😡|🤬|ተናደድኩ|አልወደድኩም|ደደብ/i.test(t);
  const sad = /sad|depressed|cry|😢|😭|ዘንድሮ|አዘንኩ|ተቸገርኩ/i.test(t);
  const happy = /happy|great|awesome|love|😊|😄|❤|ደስ|ጥሩ|አሪፍ/i.test(t);
  const urgent = /urgent|asap|emergency|አስቸኳይ|ፈጣን/i.test(t);

  if (urgent) return 'urgent';
  if (angry) return 'angry';
  if (sad) return 'sad';
  if (happy) return 'happy';
  return 'neutral';
}

/* ────────────────────────────────────────────────────────────
   ESCALATION DETECTION
   ──────────────────────────────────────────────────────────── */
function shouldEscalate(text) {
  return /ananya|owner|speak to|talk to|important|urgent|meet|business|tell her|tell ananya|notify|አናንያ|ባለቤት|አስቸኳይ|ንግድ|ንገራት|አሳውቅ|ልናገራት|ቀጠሮ/i.test(text || '');
}

/* ────────────────────────────────────────────────────────────
   TELEGRAM BOT HANDLER
   ──────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('✅ Anu AI Master Business Bot v5.0 is running.');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const OWNER_NAME = process.env.OWNER_NAME || 'Ananya';

  if (!BOT_TOKEN || !GROQ_KEY) {
    console.error('[Anu] Missing required env vars');
    return res.status(200).end();
  }

  const update = req.body || {};
  const telegramAPI = (method) =>
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

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

  /* ══════════════════════════════════════════
     DIRECT MESSAGES (owner commands)
     ══════════════════════════════════════════ */
  const directMsg = update.message;
  if (directMsg && directMsg.text) {
    const txt = directMsg.text.trim();
    const fromId = directMsg.from?.id;

    // Only respond to owner
    if (OWNER_CHAT_ID && String(fromId) !== String(OWNER_CHAT_ID)) {
      return res.status(200).json({ ok: true });
    }

    if (txt === '/start') {
      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text:
          `✅ *Anu Master Business Bot v5.0*\n\n` +
          `I auto-reply to messages on behalf of *${OWNER_NAME}*.\n\n` +
          `📋 *Commands:*\n` +
          `/start — Show this menu\n` +
          `/stats — Today's activity\n` +
          `/contacts — Recent contacts\n` +
          `/pause — Pause auto-replies\n` +
          `/resume — Resume auto-replies\n` +
          `/help — Help`,
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

    if (txt === '/stats') {
      const today = new Date().toISOString().split('T')[0];
      const stats = await fsGet('bot_analytics', today);
      const conversationsCount = stats?.conversations || 0;
      const messagesCount = stats?.messages || 0;
      const escalations = stats?.escalations || 0;

      await callAPI('sendMessage', {
        chat_id: directMsg.chat.id,
        text:
          `📊 *Today's Bot Activity*\n\n` +
          `💬 Messages received: *${messagesCount}*\n` +
          `👥 Conversations: *${conversationsCount}*\n` +
          `🔔 Escalations: *${escalations}*\n` +
          `📅 Date: ${today}`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (txt === '/contacts') {
      try {
        const q = query(
          collection(getDB(), 'bot_contacts'),
          orderBy('lastSeen', 'desc'),
          limit(10)
        );
        const snap = await getDocs(q);
        let list = '👥 *Recent Contacts*\n\n';
        snap.forEach(d => {
          const c = d.data();
          list += `• *${c.firstName} ${c.lastName || ''}*` +
                  (c.username ? ` (@${c.username})` : '') +
                  `\n  💬 "${(c.lastMessage || '').slice(0, 50)}"\n\n`;
        });
        if (snap.empty) list += '_No contacts yet_';
        await callAPI('sendMessage', {
          chat_id: directMsg.chat.id,
          text: list,
          parse_mode: 'Markdown'
        });
      } catch (e) {
        await callAPI('sendMessage', {
          chat_id: directMsg.chat.id,
          text: '❌ Could not load contacts.'
        });
      }
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

    return res.status(200).json({ ok: true });
  }

  /* ══════════════════════════════════════════
     BUSINESS MESSAGES
     ══════════════════════════════════════════ */
  const message = update.business_message || update.edited_business_message;
  if (!message) {
    return res.status(200).json({ ok: true });
  }

  const businessConnectionId = message.business_connection_id;
  const chatId = message.chat.id;
  const senderName = message.from?.first_name || 'there';
  const messageId = message.message_id;
  const senderId = message.from?.id;

  if (!businessConnectionId) {
    console.error('[Anu] MISSING business_connection_id');
    return res.status(200).json({ ok: true });
  }

  /* ─── Check global pause ─── */
  const settings = await fsGet('bot_settings', 'global');
  if (settings && settings.paused) {
    console.log('[Anu] Bot is paused globally');
    return res.status(200).json({ ok: true });
  }

  /* ─── Rate limit ─── */
  const rateCheck = await checkRateLimit(senderId);
  if (!rateCheck.allowed) {
    console.log('[Anu] Rate limit exceeded for user', senderId);
    return res.status(200).json({ ok: true });
  }

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
      console.error('[Anu] Photo fetch error:', err.message);
    }
  }

  if (!userText && !isPhoto) {
    return res.status(200).json({ ok: true });
  }

  if (userText.startsWith('/')) {
    return res.status(200).json({ ok: true });
  }

  /* ─── Save contact ─── */
  if (message.from) await saveContact(message.from, userText);

  /* ─── Analytics ─── */
  await trackAnalytics('messages');
  const existingConv = await fsGet('bot_conversations', chatId);
  if (!existingConv) await trackAnalytics('conversations');

  /* ─── Sentiment ─── */
  const sentiment = detectSentiment(userText);
  console.log('[Anu] Sentiment:', sentiment);

  /* ─── Build messages with history ─── */
  const firstName = senderName.split(' ')[0];
  const history = await getChatHistory(chatId);

  const messages = [
    { role: 'system', content: buildSystemPrompt(OWNER_NAME) }
  ];

  // Add history (converted to Groq format)
  history.forEach(h => {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.content });
    }
  });

  // Add current message
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
    callAPI('sendChatAction', {
      chat_id: chatId,
      action: isPhoto ? 'upload_photo' : 'typing',
      business_connection_id: businessConnectionId
    }).catch(() => {});

    console.log('[Anu] Calling Groq. Model:', modelToUse, '| Photo:', isPhoto, '| History:', history.length);

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

      // Fallback
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

    const groqData = await groqRes.json();
    let reply = groqData.choices?.[0]?.message?.content?.trim() || '';

    if (!reply) reply = "Hey! I'll reply soon.";
    if (reply.length > 4000) reply = reply.slice(0, 3900) + '…';

    /* ─── Human-like delay ─── */
    const delay = humanDelay(reply);
    console.log('[Anu] Delaying', Math.round(delay), 'ms before reply');
    await new Promise(r => setTimeout(r, delay));

    /* ─── Send reply ─── */
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

    /* ─── Save to history ─── */
    await saveChatHistory(chatId, userText || '[photo]', reply, firstName);

    /* ══════════════════════════════════════════
       ESCALATION TO OWNER
       ══════════════════════════════════════════ */
    const needsEscalation = shouldEscalate(userText);
    const isAngry = sentiment === 'angry';
    const isUrgent = sentiment === 'urgent';

    if ((needsEscalation || isAngry || isUrgent) && OWNER_CHAT_ID) {
      console.log('[Anu] Escalating to owner');

      let emoji = '🔔';
      let label = 'New message';
      if (isUrgent) { emoji = '🚨'; label = 'URGENT message'; }
      else if (isAngry) { emoji = '😠'; label = 'Angry sender'; }
      else if (needsEscalation) { emoji = '🔔'; label = 'Important message'; }

      const notifyText =
        `${emoji} *${label}* from ${firstName}\n\n` +
        `💬 "${userText || '[photo]'}"\n\n` +
        `🤖 Bot replied: "${reply}"\n\n` +
        `⏰ ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

      await callAPI('sendMessage', {
        chat_id: OWNER_CHAT_ID,
        text: notifyText,
        parse_mode: 'Markdown'
      }).catch(() => {});

      await trackAnalytics('escalations');
    }

    /* ─── Business hours check ─── */
    if (!isBusinessHours() && OWNER_CHAT_ID) {
      await callAPI('sendMessage', {
        chat_id: OWNER_CHAT_ID,
        text: `🌙 _Message after hours from ${firstName}: "${userText || '[photo]'}"_`,
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
