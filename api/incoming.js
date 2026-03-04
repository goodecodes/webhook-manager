import { IncomingForm } from 'formidable';
import axios from 'axios';
import crypto from 'crypto';

const DISCORD_API = 'https://discord.com/api/v10';

export const config = {
  api: { bodyParser: false }, // we will manually parse JSON or multipart
};

// Dedupe helper using Upstash Redis
async function isDuplicate(txnText) {
  const key = 'dedupe:' + crypto.createHash('sha1').update(txnText).digest('hex');

  const url = `${process.env.UPSTASH_REST_URL}/set/${encodeURIComponent(key)}/1/EX/3/NX`;

  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REST_TOKEN}` },
    });

    if (res.data?.result === 'OK') {
      console.log('✅ First time, forwarding:', txnText);
      return false;
    }

    console.log('🔁 Duplicate via Redis (atomic):', txnText);
    return true;
  } catch (err) {
    console.error('⚠️ Redis dedupe error, fallback to allow:', err.message);
    return false;
  }
}

// Read raw JSON body (because Vercel bodyParser is disabled)
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  return JSON.parse(raw);
}

// Parse multipart form and extract payload_json
function parseMultipartPayload(req) {
  const form = new IncomingForm();

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields) => {
      if (err) return reject(new Error('Error parsing form'));

      // formidable can return string or array depending on version/config
      const payloadJson = Array.isArray(fields.payload_json)
        ? fields.payload_json[0]
        : fields.payload_json;

      if (!payloadJson) return reject(new Error('Missing payload_json field'));

      try {
        resolve(JSON.parse(payloadJson));
      } catch {
        reject(new Error('Invalid JSON in payload_json'));
      }
    });
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ alive: true, now: Date.now() });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const contentType = (req.headers['content-type'] || '').toLowerCase();
  console.log('📩 Incoming webhook content-type:', contentType);

  let data;
  try {
    if (contentType.includes('application/json')) {
      data = await readJsonBody(req);
      if (!data) return res.status(400).end('Empty JSON body');
    } else {
      // default to existing multipart behavior
      data = await parseMultipartPayload(req);
    }
  } catch (e) {
    console.error('❌ Payload parse error:', e.message);
    return res.status(400).end(e.message);
  }

  // Support both your old format (data.extra.message) and some common fallbacks
  const txnText =
    data?.extra?.message ||
    data?.message ||
    data?.content ||
    data?.embeds?.[0]?.description;

  if (!txnText) {
    return res.status(400).end('Missing message text (extra.message/message/content)');
  }

  // Redis deduplication
  if (await isDuplicate(txnText)) {
    return res.status(204).end();
  }

  // Format embed
  const lower = String(txnText).toLowerCase();
  let title;
  if (lower.includes('deposited')) title = 'Deposit Made';
  else if (lower.includes('withdrawn')) title = 'Withdrawal Made';
  else title = 'Clan Coffer Update';

  const embedPayload = data?.embeds?.[0] || {
    description: txnText,
    color: 0x00ff00,
    timestamp: new Date().toISOString(),
  };

  const embed = {
    title: `<:Discord_category_collapsed_white:1394059288619782226> ${title}`,
    description: embedPayload.description || txnText,
    color: title === 'Deposit Made' ? 0x27ae60 : 0xe74c3c,
    footer: { text: 'Chat Notification | Ensure plugin coverage for accuracy' },
  };

  // Forward to Discord
  try {
    await axios.post(
      `${DISCORD_API}/channels/${process.env.TARGET_CHANNEL_ID}/messages`,
      { embeds: [embed] },
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('✅ Forwarded:', txnText);
    return res.status(200).end();
  } catch (err) {
    console.error('❌ Discord send error status:', err.response?.status);
    console.error('❌ Discord send error data:', err.response?.data);
    console.error(err.stack);

    const status = err.response?.status || 502;
    const payload = err.response?.data || 'Unknown error';
    return res.status(status).json({ error: payload });
  }
}
