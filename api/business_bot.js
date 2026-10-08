/* ============================================================
   Anu Multi-Tenant SaaS Bot v23.0
   ------------------------------------------------------------
   ✅ One bot, multi-personality
   ✅ Admin routing by chatId
   ✅ Registered clients get own AI config
   ✅ Unregistered → WebApp registration
   ✅ Trial/Active/Paused/Expired status
   ✅ Message limits per plan
   ✅ Admin dashboard via Telegram + WebApp
   ============================================================ */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const MODELS = {
  gemini: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  groq: 'openai/gpt-oss-120b'
};

const PLANS = {
  free:     { limit: 50,     days: 14,  name: 'Free Trial' },
  starter:  { limit: 500,    days: 30,  name: 'Starter' },
  pro:      { limit: 5000,   days: 30,  name: 'Pro' },
  business: { limit: 20000,  days: 30,  name: 'Business' }
};

/* ═══════════════════════════════════════════════════════════
   FIREBASE
   ═══════════════════════════════════════════════════════════ */
const FIREBASE_PROJECT_ID = 'my-ai-eaf27';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function toFS(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
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

async function fsList(col, limit = 100) {
  try {
    const r = await fetch(`${FIRESTORE_BASE}/${col}?pageSize=${limit}`);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.documents || []).map(d => ({
      id: d.name.split('/').pop(),
      ...fromFSDoc(d)
    }));
  } catch (e) { return []; }
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */
function todayKey() { return new Date().toISOString().split('T')[0]; }

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function daysBetween(d1, d2) {
  return Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
}

/* ═══════════════════════════════════════════════════════════
   CLIENT MANAGEMENT
   ═══════════════════════════════════════════════════════════ */
async function getClient(chatId) {
  return await fsGet('bot_clients', String(chatId));
}

async function getIntake(chatId) {
  return await fsGet('bot_intake', String(chatId));
}

async function getAdminConfig() {
  const data = await fsGet('bot_admin', 'config');
  return data || {
    trialDays: 14,
    setupFee: 2000,
    starterPrice: 500,
    proPrice: 1500,
    businessPrice: 3500
  };
}

async function getPaused(chatId) {
  const data = await fsGet('bot_client_state', String(chatId));
  return !!(data && data.paused === true);
}

async function setPaused(chatId, v) {
  await fsSet('bot_client_state', String(chatId), { paused: v, updatedAt: Date.now() });
}

/* ═══════════════════════════════════════════════════════════
   AI CALL
   ═══════════════════════════════════════════════════════════ */
async function callAI(messages, opts = {}) {
  const timeout = opts.timeoutMs || 20000;
  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), timeout);

  try {
    // Try Gemini first
    let r;
    if (process.env.GEMINI_API_KEY) {
      r = await fetch(GEMINI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODELS.gemini,
          messages,
          temperature: opts.temperature ?? 0.8,
          max_tokens: opts.maxTokens || 500
        }),
        signal: controller.signal
      });
    }

    // Fallback to Groq
    if (!r || !r.ok) {
      r = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODELS.groq,
          messages,
          temperature: opts.temperature ?? 0.8,
          max_tokens: opts.maxTokens || 500
        }),
        signal: controller.signal
      });
    }

    clearTimeout(tId);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };

    const data = await r.json();
    let content = data.choices?.[0]?.message?.content?.trim() || '';
    if (!content) return { ok: false, error: 'Empty' };

    content = content
      .replace(/ thinking[\s\S]*?<\/think>/gi, '')
      .replace(/^(final|reply|answer):\s*/i, '')
      .replace(/^["']|["']$/g, '')
      .trim();

    return { ok: true, content };
  } catch (e) {
    clearTimeout(tId);
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout' : e.message };
  }
}

/* ═══════════════════════════════════════════════════════════
   CLIENT-AWARE SYSTEM PROMPT
   ═══════════════════════════════════════════════════════════ */
function buildClientPrompt(client, senderName, memory) {
  const business = client.businessName || 'business';
  const owner = client.name || 'the owner';
  const type = client.businessType || 'general';
  const custom = client.customPrompt || '';
  const language = client.language || 'both';
  const tone = client.tone || 'friendly';

  const memLine = memory && memory.length > 0
    ? `\n\nCONVERSATION HISTORY (last ${Math.min(memory.length, 8)} messages):\n${memory.slice(-8).map(m => `${m.role === 'user' ? 'User' : 'Anu'}: ${m.content}`).join('\n')}`
    : '';

  return `You are **Anu** — the personal AI assistant for **${owner}** at **${business}** (${type} business in Ethiopia).

═══════════════════════════════════════════
🎯 YOUR IDENTITY
═══════════════════════════════════════════
- Your name: **Anu**
- You work for **${owner}** at **${business}**
- Created by: **Anany's**
- If asked "who are you?" → "I'm Anu, ${owner}'s AI assistant at ${business}"
- If asked "who created you?" → "Created by Anany's"

═══════════════════════════════════════════
🌍 LANGUAGE
═══════════════════════════════════════════
You understand and reply in:
- Amharic (Ge'ez: ሰላም)
- Amharic-in-Latin (selam, wendme, endet neh, min adregnalh)
- English
- Mixed

CRITICAL: Reply in the EXACT same language style they used.

${language === 'amharic' ? '→ Prefer Amharic replies when possible.' : ''}
${language === 'english' ? '→ Prefer English replies when possible.' : ''}
${language === 'both' ? '→ Match their language exactly.' : ''}

═══════════════════════════════════════════
💬 TONE
═══════════════════════════════════════════
Your tone: **${tone}**
${tone === 'friendly' ? '→ Warm, casual, like a helpful friend' : ''}
${tone === 'professional' ? '→ Professional, formal, business-appropriate' : ''}
${tone === 'friendly_professional' ? '→ Friendly yet professional' : ''}

═══════════════════════════════════════════
📋 YOUR ROLE
═══════════════════════════════════════════
You help ${owner} with:
- Business questions and advice
- Customer communication
- General assistance
- Any task they need

${custom ? `\n═══════════════════════════════════════════\n🎯 CUSTOM INSTRUCTIONS FROM ${owner.toUpperCase()}\n═══════════════════════════════════════════\n${custom}\n` : ''}

═══════════════════════════════════════════
🔁 RULES
═══════════════════════════════════════════
- Short replies (1-2 sentences)
- Warm and natural
- NEVER reveal AI model names
- NEVER show reasoning
- NEVER repeat replies
- Match gender (wendme/ante = male, ehite/anchi = female)
- Emojis: 😊 🙏 ✨ 💛

Output ONLY the reply text. No prefix — system will add it.${memLine}`;
}

/* ═══════════════════════════════════════════════════════════
   GENERATE CLIENT REPLY
   ═══════════════════════════════════════════════════════════ */
async function generateClientReply(client, chatId, senderName, userText, photoBase64) {
  const memory = (await fsGet('bot_memory', String(chatId)))?.messages || [];
  const sysPrompt = buildClientPrompt(client, senderName, memory);

  let currentMessage;
  if (photoBase64) {
    currentMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: userText
            ? `${senderName} sent a photo with caption: "${userText}"\n\nDescribe what you see and reply warmly in their language.`
            : `${senderName} sent a photo.\n\nDescribe what you see and reply warmly.`
        },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photoBase64}` } }
      ]
    };
  } else {
    currentMessage = { role: 'user', content: `${senderName}: "${userText}"` };
  }

  const messages = [
    { role: 'system', content: sysPrompt },
    ...memory.slice(-6).map(m => ({ role: m.role, content: m.content })),
    currentMessage
  ];

  const r = await callAI(messages, { maxTokens: 400, temperature: 0.85, timeoutMs: 20000 });

  if (!r.ok) {
    const isGeez = /[\u1200-\u137F]/.test(userText || '');
    return isGeez ? 'ሰላም! እንዴት ነህ? 😊' : 'Hey! How are you? 😊';
  }

  // Save to memory
  const newMemory = [...memory, { role: 'user', content: userText || '[photo]', ts: Date.now() }, { role: 'assistant', content: r.content, ts: Date.now() }];
  await fsSet('bot_memory', String(chatId), { messages: newMemory.slice(-20), updatedAt: Date.now() });

  return r.content;
}

/* ═══════════════════════════════════════════════════════════
   TYPING + SEND
   ═══════════════════════════════════════════════════════════ */
function calcTypingDelay(reply) {
  return Math.max(3000, Math.min((reply || '').length * 25, 8000));
}

async function sendWithTyping(tg, payload, replyText, bizConnId) {
  const delay = calcTypingDelay(replyText);
  const tp = { chat_id: payload.chat_id, action: 'typing' };
  if (bizConnId) tp.business_connection_id = bizConnId;

  await tg('sendChatAction', tp).catch(() => {});
  setTimeout(() => tg('sendChatAction', tp).catch(() => {}), Math.floor(delay / 2));
  await new Promise(r => setTimeout(r, delay));
  return tg('sendMessage', payload);
}

/* ═══════════════════════════════════════════════════════════
   STATUS CHECK
   ═══════════════════════════════════════════════════════════ */
async function checkClientStatus(client) {
  const now = Date.now();
  const adminConfig = await getAdminConfig();
  const trialDays = adminConfig.trialDays || 14;

  // Check trial expiry
  if (client.status === 'trial' && client.trialEnd && now > client.trialEnd) {
    await fsSet('bot_clients', client.id, { status: 'expired' });
    return 'expired';
  }

  // Check paid expiry
  if (client.status === 'active' && client.paidUntil && now > client.paidUntil) {
    await fsSet('bot_clients', client.id, { status: 'expired' });
    return 'expired';
  }

  // Check message limit
  if (client.messagesUsed >= (client.messagesLimit || PLANS[client.plan]?.limit || 500)) {
    return 'limit_reached';
  }

  return client.status || 'trial';
}

async function incrementUsage(chatId) {
  const client = await getClient(chatId);
  if (!client) return;
  await fsSet('bot_clients', String(chatId), {
    messagesUsed: (client.messagesUsed || 0) + 1,
    lastUsedAt: Date.now()
  });
  await fsSet('bot_analytics', todayKey(), {
    messages: ((await fsGet('bot_analytics', todayKey()))?.messages || 0) + 1,
    lastUpdate: Date.now()
  });
}

/* ═══════════════════════════════════════════════════════════
   ADMIN COMMANDS
   ═══════════════════════════════════════════════════════════ */
async function handleAdminCommand(tg, chatId, txt, BOT_TOKEN) {
  const parts = txt.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg1 = parts[1];
  const arg2 = parts[2];
  const rest = parts.slice(1).join(' ');

  const send = (text, opts = {}) => tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...opts
  });

  switch (cmd) {
    case '/start':
    case '/admin': {
      const adminConfig = await getAdminConfig();
      const clients = await fsList('bot_clients');
      const intake = await fsList('bot_intake');
      const pending = intake.filter(i => i.status === 'pending');
      const active = clients.filter(c => c.status === 'active' || c.status === 'trial');
      const paid = clients.filter(c => c.status === 'active');

      await send(
        `👑 <b>Anu Admin Panel v23.0</b>\n\n` +
        `<b>━━━ OVERVIEW ━━━</b>\n` +
        `👥 Total Clients: <b>${clients.length}</b>\n` +
        `🟢 Active/Trial: <b>${active.length}</b>\n` +
        `💰 Paid: <b>${paid.length}</b>\n` +
        `📋 Pending: <b>${pending.length}</b>\n` +
        `🎁 Trial Days: <b>${adminConfig.trialDays || 14}</b>\n\n` +
        `<b>━━━ COMMANDS ━━━</b>\n` +
        `<b>📊 Info</b>\n` +
        `<code>/stats</code> — Full statistics\n` +
        `<code>/pending</code> — Pending approvals\n` +
        `<code>/clients</code> — All clients\n` +
        `<code>/client &lt;id&gt;</code> — Client details\n\n` +
        `<b>✅ Approval</b>\n` +
        `<code>/approve &lt;id&gt; [plan]</code>\n` +
        `<code>/reject &lt;id&gt;</code>\n\n` +
        `<b>⚙️ Control</b>\n` +
        `<code>/pause &lt;id&gt;</code> — Pause client\n` +
        `<code>/resume &lt;id&gt;</code> — Resume\n` +
        `<code>/extend &lt;id&gt; &lt;days&gt;</code> — Extend\n` +
        `<code>/plan &lt;id&gt; &lt;plan&gt;</code> — Change plan\n` +
        `<code>/reset &lt;id&gt;</code> — Reset usage\n` +
        `<code>/delete &lt;id&gt;</code> — Delete client\n\n` +
        `<b>🎛️ Settings</b>\n` +
        `<code>/trial &lt;days&gt;</code> — Trial duration\n` +
        `<code>/broadcast &lt;msg&gt;</code> — Message all\n` +
        `<code>/webapp</code> — Open admin panel`
      );
      return;
    }

    case '/stats': {
      const clients = await fsList('bot_clients');
      const today = await fsGet('bot_analytics', todayKey()) || {};
      const adminConfig = await getAdminConfig();

      const byPlan = { free: 0, starter: 0, pro: 0, business: 0 };
      const byStatus = { trial: 0, active: 0, paused: 0, expired: 0 };

      let monthlyRevenue = 0;
      clients.forEach(c => {
        byPlan[c.plan] = (byPlan[c.plan] || 0) + 1;
        byStatus[c.status] = (byStatus[c.status] || 0) + 1;
        if (c.status === 'active') {
          if (c.plan === 'starter') monthlyRevenue += adminConfig.starterPrice || 500;
          if (c.plan === 'pro') monthlyRevenue += adminConfig.proPrice || 1500;
          if (c.plan === 'business') monthlyRevenue += adminConfig.businessPrice || 3500;
        }
      });

      await send(
        `📊 <b>Statistics</b>\n\n` +
        `<b>━━━ REVENUE ━━━</b>\n` +
        `💰 Monthly: <b>${monthlyRevenue.toLocaleString()} ብር</b>\n` +
        `📈 Yearly: <b>${(monthlyRevenue * 12).toLocaleString()} ብር</b>\n\n` +
        `<b>━━━ CLIENTS ━━━</b>\n` +
        `🆓 Free: ${byPlan.free}\n` +
        `🥉 Starter: ${byPlan.starter}\n` +
        `🥈 Pro: ${byPlan.pro}\n` +
        `🥇 Business: ${byPlan.business}\n\n` +
        `<b>━━━ STATUS ━━━</b>\n` +
        `🎁 Trial: ${byStatus.trial}\n` +
        `🟢 Active: ${byStatus.active}\n` +
        `⏸️ Paused: ${byStatus.paused}\n` +
        `❌ Expired: ${byStatus.expired}\n\n` +
        `<b>━━━ TODAY ━━━</b>\n` +
        `💬 Messages: <b>${today.messages || 0}</b>`
      );
      return;
    }

    case '/pending': {
      const intake = await fsList('bot_intake');
      const pending = intake.filter(i => i.status === 'pending');

      if (!pending.length) {
        await send('✅ No pending registrations.');
        return;
      }

      let msg = `📋 <b>Pending (${pending.length})</b>\n\n`;
      pending.slice(0, 10).forEach((p, i) => {
        msg += `<b>${i + 1}.</b> ${esc(p.name || 'Unknown')}\n`;
        msg += `   🆔 <code>${p.id}</code>\n`;
        msg += `   📱 ${esc(p.phone || '-')}\n`;
        msg += `   🏢 ${esc(p.businessName || '-')}\n`;
        msg += `   📅 ${new Date(p.createdAt).toLocaleDateString()}\n\n`;
      });
      msg += `\nUse: <code>/approve &lt;id&gt;</code> or <code>/reject &lt;id&gt;</code>`;
      await send(msg);
      return;
    }

    case '/clients': {
      const clients = await fsList('bot_clients');
      if (!clients.length) {
        await send('No clients yet.');
        return;
      }

      let msg = `👥 <b>Clients (${clients.length})</b>\n\n`;
      clients.slice(0, 20).forEach((c, i) => {
        const icon = c.status === 'active' ? '🟢' : c.status === 'trial' ? '🎁' : c.status === 'paused' ? '⏸️' : '❌';
        msg += `${icon} <b>${esc(c.name || 'Unknown')}</b>\n`;
        msg += `   🆔 <code>${c.id}</code>\n`;
        msg += `   🏢 ${esc(c.businessName || '-')}\n`;
        msg += `   📊 ${c.plan || 'free'} · ${c.messagesUsed || 0}/${c.messagesLimit || 500}\n\n`;
      });
      if (clients.length > 20) msg += `\n... and ${clients.length - 20} more`;
      await send(msg);
      return;
    }

    case '/client': {
      if (!arg1) {
        await send('Usage: <code>/client &lt;chat_id&gt;</code>');
        return;
      }
      const c = await getClient(arg1);
      if (!c) {
        await send('❌ Client not found.');
        return;
      }
      const days = c.trialEnd ? daysBetween(Date.now(), c.trialEnd) : null;
      const paidDays = c.paidUntil ? daysBetween(Date.now(), c.paidUntil) : null;

      await send(
        `👤 <b>${esc(c.name)}</b>\n` +
        `🆔 <code>${c.id}</code>\n\n` +
        `<b>━━━ BUSINESS ━━━</b>\n` +
        `🏢 ${esc(c.businessName || '-')}\n` +
        `📂 ${esc(c.businessType || '-')}\n` +
        `📱 ${esc(c.phone || '-')}\n` +
        `📧 ${esc(c.email || '-')}\n\n` +
        `<b>━━━ STATUS ━━━</b>\n` +
        `📊 Plan: <b>${c.plan || 'free'}</b>\n` +
        `🚦 Status: <b>${c.status || 'trial'}</b>\n` +
        `💬 Usage: <b>${c.messagesUsed || 0} / ${c.messagesLimit || 500}</b>\n` +
        (days !== null ? `🎁 Trial: ${days > 0 ? days + ' days left' : 'Expired'}\n` : '') +
        (paidDays !== null ? `💰 Paid: ${paidDays > 0 ? paidDays + ' days left' : 'Expired'}\n` : '') +
        `📅 Created: ${new Date(c.createdAt).toLocaleDateString()}\n\n` +
        `<b>━━━ ACTIONS ━━━</b>\n` +
        `<code>/pause ${c.id}</code>\n` +
        `<code>/resume ${c.id}</code>\n` +
        `<code>/extend ${c.id} 30</code>\n` +
        `<code>/plan ${c.id} pro</code>\n` +
        `<code>/reset ${c.id}</code>\n` +
        `<code>/delete ${c.id}</code>`
      );
      return;
    }

    case '/approve': {
      if (!arg1) {
        await send('Usage: <code>/approve &lt;chat_id&gt; [plan]</code>');
        return;
      }
      const plan = arg2 || 'free';
      const intake = await getIntake(arg1);
      if (!intake) {
        await send('❌ Registration not found.');
        return;
      }

      const adminConfig = await getAdminConfig();
      const trialDays = adminConfig.trialDays || 14;
      const planConfig = PLANS[plan] || PLANS.free;

      await fsSet('bot_clients', arg1, {
        ...intake,
        plan,
        status: plan === 'free' ? 'trial' : 'active',
        messagesUsed: 0,
        messagesLimit: planConfig.limit,
        trialStart: Date.now(),
        trialEnd: Date.now() + (trialDays * 24 * 60 * 60 * 1000),
        paidUntil: plan === 'free' ? null : Date.now() + (planConfig.days * 24 * 60 * 60 * 1000),
        approvedAt: Date.now()
      });

      await fsSet('bot_intake', arg1, { status: 'approved' });

      await send(
        `✅ <b>Approved!</b>\n\n` +
        `👤 ${esc(intake.name)}\n` +
        `📊 Plan: ${plan}\n` +
        `🎁 Trial: ${trialDays} days\n` +
        `💬 Limit: ${planConfig.limit} msgs`
      );

      // Notify client
      try {
        await tg('sendMessage', {
          chat_id: arg1,
          text:
            `🎉 <b>Welcome to Anu AI!</b>\n\n` +
            `Your account has been activated ✅\n\n` +
            `📊 Plan: <b>${planConfig.name}</b>\n` +
            `🎁 Free for: <b>${trialDays} days</b>\n` +
            `💬 Messages: <b>${planConfig.limit}</b>\n\n` +
            `You can now chat with me anytime. Just send a message!\n\n` +
            `Try: <code>ሰላም</code> or <code>Hi</code>`,
          parse_mode: 'HTML'
        });
      } catch (e) {}
      return;
    }

    case '/reject': {
      if (!arg1) {
        await send('Usage: <code>/reject &lt;chat_id&gt;</code>');
        return;
      }
      const intake = await getIntake(arg1);
      if (!intake) {
        await send('❌ Registration not found.');
        return;
      }
      await fsSet('bot_intake', arg1, { status: 'rejected' });

      await send(`❌ Rejected ${esc(intake.name)}`);

      try {
        await tg('sendMessage', {
          chat_id: arg1,
          text: `❌ Sorry, your registration was not approved.\n\nFor questions, please contact support.`,
          parse_mode: 'HTML'
        });
      } catch (e) {}
      return;
    }

    case '/pause': {
      if (!arg1) { await send('Usage: <code>/pause &lt;id&gt;</code>'); return; }
      const c = await getClient(arg1);
      if (!c) { await send('❌ Not found.'); return; }
      await fsSet('bot_clients', arg1, { status: 'paused' });
      await send(`⏸️ Paused ${esc(c.name)}`);
      try {
        await tg('sendMessage', { chat_id: arg1, text: '⏸️ Your account has been paused. Please contact support.' });
      } catch (e) {}
      return;
    }

    case '/resume': {
      if (!arg1) { await send('Usage: <code>/resume &lt;id&gt;</code>'); return; }
      const c = await getClient(arg1);
      if (!c) { await send('❌ Not found.'); return; }
      await fsSet('bot_clients', arg1, { status: c.trialEnd && c.trialEnd > Date.now() ? 'trial' : 'active' });
      await send(`▶️ Resumed ${esc(c.name)}`);
      try {
        await tg('sendMessage', { chat_id: arg1, text: '▶️ Your account has been resumed. You can chat again!' });
      } catch (e) {}
      return;
    }

    case '/extend': {
      if (!arg1 || !arg2) { await send('Usage: <code>/extend &lt;id&gt; &lt;days&gt;</code>'); return; }
      const c = await getClient(arg1);
      if (!c) { await send('❌ Not found.'); return; }
      const days = parseInt(arg2, 10);
      const newPaidUntil = Math.max(c.paidUntil || Date.now(), Date.now()) + (days * 24 * 60 * 60 * 1000);
      await fsSet('bot_clients', arg1, { paidUntil: newPaidUntil, status: 'active' });
      await send(`✅ Extended ${esc(c.name)} by ${days} days`);
      try {
        await tg('sendMessage', { chat_id: arg1, text: `✅ Your account extended by ${days} days! 🎉` });
      } catch (e) {}
      return;
    }

    case '/plan': {
      if (!arg1 || !arg2) { await send('Usage: <code>/plan &lt;id&gt; &lt;free|starter|pro|business&gt;</code>'); return; }
      const c = await getClient(arg1);
      if (!c) { await send('❌ Not found.'); return; }
      const planConfig = PLANS[arg2];
      if (!planConfig) { await send('❌ Invalid plan. Use: free, starter, pro, business'); return; }
      await fsSet('bot_clients', arg1, {
        plan: arg2,
        messagesLimit: planConfig.limit,
        status: arg2 === 'free' ? 'trial' : 'active'
      });
      await send(`✅ ${esc(c.name)} → ${planConfig.name}`);
      return;
    }

    case '/reset': {
      if (!arg1) { await send('Usage: <code>/reset &lt;id&gt;</code>'); return; }
      const c = await getClient(arg1);
      if (!c) { await send('❌ Not found.'); return; }
      await fsSet('bot_clients', arg1, { messagesUsed: 0 });
      await send(`🔄 Reset usage for ${esc(c.name)}`);
      return;
    }

    case '/delete': {
      if (!arg1) { await send('Usage: <code>/delete &lt;id&gt;</code>'); return; }
      const c = await getClient(arg1);
      if (!c) { await send('❌ Not found.'); return; }
      await fsDelete('bot_clients', arg1);
      await fsDelete('bot_intake', arg1);
      await fsDelete('bot_memory', arg1);
      await send(`🗑️ Deleted ${esc(c.name)}`);
      return;
    }

    case '/trial': {
      if (!arg1) { await send('Usage: <code>/trial &lt;days&gt;</code>'); return; }
      const days = parseInt(arg1, 10);
      if (isNaN(days) || days < 1 || days > 365) {
        await send('❌ Days must be 1-365');
        return;
      }
      await fsSet('bot_admin', 'config', { trialDays: days });
      await send(`✅ Trial set to ${days} days`);
      return;
    }

    case '/broadcast': {
      if (!rest) { await send('Usage: <code>/broadcast &lt;message&gt;</code>'); return; }
      const clients = await fsList('bot_clients');
      let sent = 0;
      for (const c of clients) {
        try {
          await tg('sendMessage', { chat_id: c.id, text: `📢 ${rest}` });
          sent++;
          await new Promise(r => setTimeout(r, 100));
        } catch (e) {}
      }
      await send(`✅ Sent to ${sent}/${clients.length} clients`);
      return;
    }

    case '/webapp': {
      const adminUrl = process.env.ANU_APP_URL || 'https://anu-ai.vercel.app';
      await send(
        `📱 <b>Admin Dashboard</b>\n\nOpen the full admin panel:`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '📊 Open Admin Panel', web_app: { url: `${adminUrl}/admin` } }
            ]]
          }
        }
      );
      return;
    }

    case '/help': {
      await send(
        `<b>Admin Commands</b>\n\n` +
        `/stats — Statistics\n` +
        `/pending — Pending approvals\n` +
        `/clients — All clients\n` +
        `/client &lt;id&gt; — Details\n` +
        `/approve &lt;id&gt; [plan]\n` +
        `/reject &lt;id&gt;\n` +
        `/pause &lt;id&gt;\n` +
        `/resume &lt;id&gt;\n` +
        `/extend &lt;id&gt; &lt;days&gt;\n` +
        `/plan &lt;id&gt; &lt;plan&gt;\n` +
        `/reset &lt;id&gt;\n` +
        `/delete &lt;id&gt;\n` +
        `/trial &lt;days&gt;\n` +
        `/broadcast &lt;msg&gt;\n` +
        `/webapp — Admin panel`
      );
      return;
    }

    default: {
      // Not a command
      await send('Use /help for admin commands.');
      return;
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   FETCH PHOTO
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
  } catch (e) { return null; }
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Multi-Tenant Bot v23.0',
      type: 'SaaS',
      plans: Object.keys(PLANS)
    });
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const APP_URL = process.env.ANU_APP_URL || 'https://anu-ai.vercel.app';

  if (!BOT_TOKEN || (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY)) {
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
      if (!data.ok) console.error(`[${method}]`, JSON.stringify(data).slice(0, 200));
      return data;
    } catch (e) {
      return null;
    }
  }

  /* ══════════════ DIRECT MESSAGES ══════════════ */
  const dm = update.message;
  if (dm) {
    const fromId = dm.from?.id;
    const chatId = dm.chat.id;
    const txt = (dm.text || dm.caption || '').trim();
    const firstName = dm.from?.first_name || 'there';

    /* ─── 1️⃣ ADMIN ─── */
    if (String(chatId) === String(OWNER_CHAT_ID)) {
      await handleAdminCommand(tg, chatId, txt, BOT_TOKEN);
      return res.status(200).json({ ok: true });
    }

    /* ─── 2️⃣ ADMIN REPLY TO NOTIFICATION ─── */
    if (dm.reply_to_message && txt) {
      const repliedText = dm.reply_to_message.text || dm.reply_to_message.caption || '';
      const ref = repliedText.match(/REF:([0-9-]+):([a-zA-Z0-9_-]+)/);
      if (ref) {
        const payload = { chat_id: ref[1], text: txt };
        if (ref[2] !== 'direct') payload.business_connection_id = ref[2];
        const sr = await tg('sendMessage', payload);
        await tg('sendMessage', {
          chat_id: chatId,
          text: sr && sr.ok ? '✅ Sent' : '❌ Failed',
          reply_to_message_id: dm.message_id
        });
        return res.status(200).json({ ok: true });
      }
    }

    /* ─── 3️⃣ /start ─── */
    if (txt === '/start') {
      const client = await getClient(chatId);
      const intake = await getIntake(chatId);

      if (!client) {
        // Not registered
        const welcomeText = intake && intake.status === 'pending'
          ? `⏳ <b>Registration Pending</b>\n\nHi ${esc(firstName)}! Your registration is being reviewed.\n\nYou'll be notified once approved. Thank you for your patience! 🙏`
          : intake && intake.status === 'rejected'
            ? `❌ <b>Registration Rejected</b>\n\nSorry, your application was not approved.\n\nFor questions, contact support.`
            : `👋 <b>Welcome to Anu AI!</b>\n\nI'm <b>Anu</b> — a personal AI assistant for your business.\n\n📌 <b>What I do:</b>\n• Answer questions in Amharic + English\n• Help with your business tasks\n• Available 24/7\n\n🎁 <b>14-day free trial</b>\n\n<b>To get started, register below:</b>`;

        await tg('sendMessage', {
          chat_id: chatId,
          text: welcomeText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 Register Now', web_app: { url: `${APP_URL}/webapp` } }],
              [{ text: 'ℹ️ Learn More', callback_data: 'learn_more' }]
            ]
          }
        });
        return res.status(200).json({ ok: true });
      }

      // Registered
      const status = await checkClientStatus(client);
      const statusMsg = status === 'trial'
        ? `🎁 <b>Trial Active</b> — ${daysBetween(Date.now(), client.trialEnd)} days left`
        : status === 'active'
          ? `✅ <b>Active</b> — ${daysBetween(Date.now(), client.paidUntil)} days left`
          : status === 'paused'
            ? `⏸️ <b>Paused</b> — Contact support`
            : status === 'expired'
              ? `❌ <b>Expired</b> — Please renew`
              : `⚠️ ${status}`;

      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `👋 <b>Welcome back, ${esc(client.name)}!</b>\n\n` +
          `🏢 ${esc(client.businessName || '-')}\n` +
          `📊 Plan: <b>${PLANS[client.plan]?.name || 'Free'}</b>\n` +
          `💬 Usage: <b>${client.messagesUsed || 0} / ${client.messagesLimit || 500}</b>\n\n` +
          statusMsg + '\n\n' +
          `Just send me a message to start! 😊`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👤 My Account', web_app: { url: `${APP_URL}/webapp` } }]
          ]
        }
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 4️⃣ REGULAR MESSAGE ─── */
    const client = await getClient(chatId);
    if (!client) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `👋 Please register first to use Anu AI.\n\nUse /start to get started.`,
        reply_markup: {
          inline_keyboard: [[{ text: '🚀 Register', web_app: { url: `${APP_URL}/webapp` } }]]
        }
      });
      return res.status(200).json({ ok: true });
    }

    // Check status
    const status = await checkClientStatus(client);
    if (status === 'paused') {
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ Your account is paused. Contact support.' });
      return res.status(200).json({ ok: true });
    }
    if (status === 'expired') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `❌ Your trial has expired.\n\nTo continue, please renew your subscription.`,
        reply_markup: {
          inline_keyboard: [[{ text: '💳 Renew', web_app: { url: `${APP_URL}/webapp` } }]]
        }
      });
      return res.status(200).json({ ok: true });
    }
    if (status === 'limit_reached') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `⚠️ You've reached your message limit (${client.messagesLimit}).\n\nUpgrade to continue.`,
        reply_markup: {
          inline_keyboard: [[{ text: '⬆️ Upgrade', web_app: { url: `${APP_URL}/webapp` } }]]
        }
      });
      return res.status(200).json({ ok: true });
    }

    // Check per-client paused
    if (await getPaused(chatId)) return res.status(200).json({ ok: true });

    // Fetch photo
    let photoBase64 = null;
    if (dm.photo && dm.photo.length > 0) {
      const largest = dm.photo[dm.photo.length - 1];
      photoBase64 = await fetchPhotoBase64(BOT_TOKEN, largest.file_id);
    }

    if (!txt && !photoBase64) return res.status(200).json({ ok: true });

    // Generate reply
    let reply = '';
    try {
      reply = await generateClientReply(client, chatId, firstName, txt, photoBase64);
    } catch (e) {
      console.error('[AI Error]', e.message);
      reply = /[\u1200-\u137F]/.test(txt) ? 'ሰላም! እንዴት ነህ? 😊' : 'Hey! How are you? 😊';
    }

    // Send with typing
    await sendWithTyping(tg, {
      chat_id: chatId,
      text: `anu bot: ${reply}`,
      reply_to_message_id: dm.message_id
    }, reply, null);

    // Increment usage
    await incrementUsage(chatId);

    // Notify admin if user wants owner
    const wantsOwner = /(ananya|anani|አናንያ|አናኒ|owner|boss|admin|support|help me|እርዳ)/i.test(txt);
    if (wantsOwner) {
      await tg('sendMessage', {
        chat_id: OWNER_CHAT_ID,
        text:
          `📩 <b>Support Request</b>\n\n` +
          `👤 ${esc(client.name)}\n` +
          `🆔 <code>${chatId}</code>\n` +
          `🏢 ${esc(client.businessName || '-')}\n\n` +
          `💬 <i>"${esc(txt)}"</i>\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `↩️ Reply to this message\n\n` +
          `<code>REF:${chatId}:direct</code>`,
        parse_mode: 'HTML'
      });
    }

    return res.status(200).json({ ok: true });
  }

  /* ══════════════ CALLBACK QUERIES ══════════════ */
  if (update.callback_query) {
    const cb = update.callback_query;
    await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

    if (cb.data === 'learn_more') {
      await tg('sendMessage', {
        chat_id: cb.message.chat.id,
        text:
          `🤖 <b>About Anu AI</b>\n\n` +
          `<b>What I do:</b>\n` +
          `• 24/7 AI assistant\n` +
          `• Amharic + English\n` +
          `• Photo analysis\n` +
          `• Business help\n\n` +
          `<b>Pricing:</b>\n` +
          `🆓 Free Trial — 14 days\n` +
          `🥉 Starter — 500 ብር/ወር\n` +
          `🥈 Pro — 1,500 ብር/ወር\n` +
          `🥇 Business — 3,500 ብር/ወር\n\n` +
          `Created by <b>Anany's</b>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🚀 Register', web_app: { url: `${APP_URL}/webapp` } }]]
        }
      });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
}
