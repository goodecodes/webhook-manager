// api/incoming.js
import { IncomingForm } from 'formidable';
import axios from 'axios';

export const config = {
   api: { bodyParser: false }   // disable Vercel’s built-in parser
};

const DEDUP_WINDOW = 1_000;     // 1 second
const seen = new Map(); // message→timestamp

export default async function handler(req, res) {
   console.log('⤵️ DISCORD_WEBHOOK_URL:', process.env.DISCORD_WEBHOOK_URL);
   // ─── Health check ─────────────────────────
   if (req.method === 'GET') {
      return res
         .status(200)
         .json({ alive: true, now: Date.now() });
   }

   // ─── Only allow POSTs ──────────────────────
   if (req.method !== 'POST') {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
   }

   // ─── Parse the multipart/form-data ─────────
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

      // ─── JSON parse & extract message ─────────
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

      // ─── Dedupe within window ──────────────────
      const now = Date.now();
      const last = seen.get(txnText) || 0;
      if (now - last < DEDUP_WINDOW) {
         console.log('↩️ Duplicate, skipping:', txnText);
         return res.sendStatus(204);
      }
      seen.set(txnText, now);
      // prune old entries
      for (const [text, ts] of seen) {
         if (now - ts > DEDUP_WINDOW) seen.delete(text);
      }

      // ─── Forward to Discord ────────────────────
      try {
         await axios.post(
            process.env.DISCORD_WEBHOOK_URL,
            { content: txnText }
         );
         console.log('✅ Forwarded:', txnText);
         return res.sendStatus(200);
      } catch (err) {
         console.error('❌ Discord send error status:', err.response?.status);
         console.error('❌ Discord send error data:', err.response?.data);
         console.error(err.stack);
         return res.status(500).end('Error forwarding to Discord');
      }
   });
}
