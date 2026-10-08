
/* ============================================================
   Anu WebApp API — Registration + Client endpoints
   ============================================================ */

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

async function notifyAdmin(BOT_TOKEN, OWNER_CHAT_ID, intake) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        text:
          `🆕 <b>New Registration</b>\n\n` +
          `👤 <b>${intake.name}</b>\n` +
          `🆔 <code>${intake.chatId}</code>\n` +
          `📱 ${intake.phone || '-'}\n` +
          `📧 ${intake.email || '-'}\n` +
          `🏢 ${intake.businessName || '-'}\n` +
          `📂 ${intake.businessType || '-'}\n\n` +
          `<b>💬 Purpose:</b>\n<i>${intake.purpose || '-'}</i>\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `✅ <code>/approve ${intake.chatId} free</code>\n` +
          `❌ <code>/reject ${intake.chatId}</code>`,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action) || '';

  try {
    /* ─── REGISTER ─── */
    if (action === 'register' && req.method === 'POST') {
      const body = req.body || {};
      const chatId = String(body.chatId || '').trim();

      if (!chatId || !body.name) {
        return res.status(400).json({ ok: false, error: 'Missing name or chatId' });
      }

      const existing = await fsGet('bot_clients', chatId);
      if (existing) {
        return res.status(400).json({ ok: false, error: 'Already registered' });
      }

      const intake = {
        chatId,
        name: String(body.name).slice(0, 100),
        phone: String(body.phone || '').slice(0, 30),
        email: String(body.email || '').slice(0, 100),
        businessName: String(body.businessName || '').slice(0, 100),
        businessType: String(body.businessType || 'general').slice(0, 50),
        purpose: String(body.purpose || '').slice(0, 500),
        language: String(body.language || 'both').slice(0, 20),
        tone: String(body.tone || 'friendly').slice(0, 30),
        status: 'pending',
        createdAt: Date.now()
      };

      await fsSet('bot_intake', chatId, intake);
      await notifyAdmin(process.env.BUSINESS_BOT_TOKEN, process.env.OWNER_CHAT_ID, intake);

      return res.status(200).json({ ok: true, message: 'Registration submitted' });
    }

    /* ─── STATUS ─── */
    if (action === 'status' && req.method === 'GET') {
      const chatId = String(req.query.chatId || '').trim();
      if (!chatId) return res.status(400).json({ ok: false, error: 'Missing chatId' });

      const client = await fsGet('bot_clients', chatId);
      const intake = await fsGet('bot_intake', chatId);

      if (client) {
        const now = Date.now();
        const trialDaysLeft = client.trialEnd ? Math.max(0, Math.ceil((client.trialEnd - now) / 86400000)) : 0;
        const paidDaysLeft = client.paidUntil ? Math.max(0, Math.ceil((client.paidUntil - now) / 86400000)) : 0;

        return res.status(200).json({
          ok: true,
          registered: true,
          client: {
            name: client.name,
            businessName: client.businessName,
            plan: client.plan,
            status: client.status,
            messagesUsed: client.messagesUsed || 0,
            messagesLimit: client.messagesLimit || 500,
            trialDaysLeft,
            paidDaysLeft
          }
        });
      }

      if (intake) {
        return res.status(200).json({
          ok: true,
          registered: false,
          pending: intake.status === 'pending',
          rejected: intake.status === 'rejected'
        });
      }

      return res.status(200).json({ ok: true, registered: false, new: true });
    }

    /* ─── ADMIN: LIST PENDING ─── */
    if (action === 'pending' && req.method === 'GET') {
      const chatId = String(req.query.chatId || '');
      if (chatId !== String(process.env.OWNER_CHAT_ID)) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }
      const r = await fetch(`${FIRESTORE_BASE}/bot_intake?pageSize=100`);
      const data = await r.json();
      const items = (data.documents || []).map(d => ({
        id: d.name.split('/').pop(),
        ...fromFSDoc(d)
      })).filter(x => x.status === 'pending');
      return res.status(200).json({ ok: true, items });
    }

    /* ─── ADMIN: LIST CLIENTS ─── */
    if (action === 'clients' && req.method === 'GET') {
      const chatId = String(req.query.chatId || '');
      if (chatId !== String(process.env.OWNER_CHAT_ID)) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }
      const r = await fetch(`${FIRESTORE_BASE}/bot_clients?pageSize=100`);
      const data = await r.json();
      const items = (data.documents || []).map(d => ({
        id: d.name.split('/').pop(),
        ...fromFSDoc(d)
      }));
      return res.status(200).json({ ok: true, items });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('[WebApp API]', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
