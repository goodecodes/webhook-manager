import { IncomingForm } from 'formidable';
import axios from 'axios';
import crypto from 'crypto';

const DISCORD_API = 'https://discord.com/api/v10';

export const config = {
   api: { bodyParser: false },
};

// Dedupe helper using Upstash Redis
async function isDuplicate(txnText) {
   // generate a unique key
   const key =
      'dedupe:' + crypto.createHash('sha1').update(txnText).digest('hex');

   // Upstash wants: /set/<key>/<value>/EX/<seconds>/NX
   // e.g. SET key 1 EX 10 NX
   const url = `${process.env.UPSTASH_REST_URL}/set/${encodeURIComponent(
      key
   )}/1/EX/10/NX`;

   try {
      // note: Upstash examples use GET for REST calls
      const res = await axios.get(url, {
         headers: {
            Authorization: `Bearer ${process.env.UPSTASH_REST_TOKEN}`,
         },
      });

      // on first call res.data.result === 'OK'
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





export default async function handler(req, res) {
   if (req.method === 'GET') {
      return res.status(200).json({ alive: true, now: Date.now() });
   }

   if (req.method !== 'POST') {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
   }

   const form = new IncomingForm();
   form.parse(req, async (err, fields) => {
      if (err) {
         console.error('Form parse error:', err);
         return res.status(400).end('Error parsing form');
      }

      const payloadJson = fields.payload_json;
      if (!payloadJson) {
         return res.status(400).end('Missing payload_json field');
      }

      let data;
      try {
         data = JSON.parse(payloadJson);
      } catch {
         return res.status(400).end('Invalid JSON in payload_json');
      }

      const txnText = data.extra?.message;
      if (!txnText) {
         return res.status(400).end('Missing extra.message');
      }

      // Redis deduplication
      if (await isDuplicate(txnText)) {
         return res.status(204).end();
      }

      // Format embed
      const lower = txnText.toLowerCase();
      let title;
      if (lower.includes('deposited')) {
         title = 'Deposit Made';
      } else if (lower.includes('withdrawn')) {
         title = 'Withdrawal Made';
      } else {
         title = 'Clan Coffer Update';
      }

      const embedPayload = data.embeds?.[0] || {
         description: txnText,
         color: 0x00ff00,
         timestamp: new Date().toISOString(),
      };

      const embed = {
         title: `<:Discord_category_collapsed_white:1394059288619782226> ${title}`,
         description: embedPayload.description || txnText,
         timestamp: embedPayload.timestamp ?? new Date().toISOString(),
         color: title === 'Deposit Made' ? 0x27ae60 : 0xe74c3c,
         footer: {
            text: 'Chat Notification. Ensure plugin coverage for accuracy',
         },
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
         const data = err.response?.data || 'Unknown error';
         return res.status(status).json({ error: data });
      }
   });
}
