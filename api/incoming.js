import { IncomingForm } from 'formidable';
import axios from 'axios';

export const config = {
   api: { bodyParser: false }
};

const DEDUP_WINDOW = 1_000;
const seen = new Map();

export default async function handler(req, res) {
   if (req.method === 'GET') {
      return res
         .status(200)
         .json({ alive: true, now: Date.now() });
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

      // dedupe
      const now = Date.now();
      const last = seen.get(txnText) || 0;
      if (now - last < DEDUP_WINDOW) {
         console.log('Duplicate, skipping:', txnText);
         return res.status(204).end();
      }
      seen.set(txnText, now);
      for (const [text, ts] of seen) {
         if (now - ts > DEDUP_WINDOW) seen.delete(text);
      }

      // define `lower` here
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

      // forward
      try {
         //await axios.post(
         //   process.env.DISCORD_WEBHOOK_URL,
         //   { content: txnText }
         //);


         await axios.post(process.env.DISCORD_WEBHOOK_URL, {

            // username: 'StackBot',
            avatar_url: 'https://i.imgur.com/jsjW0dF.png',
            embeds: [
               {

                  // ...embedPayload,

                  title,
                  description: embedPayload.description || txnText,
                  timestamp: embedPayload.timestamp ?? new Date().toISOString(),
               },
            ],
         });

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
