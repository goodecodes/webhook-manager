// api/incoming.js

import { Busboy } from 'busboy';
import axios from 'axios';

export const config = {
   api: { bodyParser: false }    // disable Vercel’s default parser
};

const DEDUP_WINDOW = 1_000;      // ms
const seen = new Map();  // txnText → timestamp

export default async function handler(req, res) {
   // ─── Health-check ───────────────────────────────────────────────
   if (req.method === 'GET') {
      return res
         .status(200)
         .json({ status: '✅ incoming.js is live', now: Date.now() });
   }

   // ─── Only accept multipart POSTs ────────────────────────────────
   if (req.method !== 'POST') {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
   }
   const ct = req.headers['content-type'] || '';
   if (!ct.startsWith('multipart/form-data')) {
      return res.status(415).end('Unsupported Media Type');
   }

   // ─── Parse the form and pull out payload_json ──────────────────
   const busboy = new Busboy({ headers: req.headers });
   let payloadJson = '';

   busboy.on('field', (name, val) => {
      if (name === 'payload_json') payloadJson = val;
   });

   busboy.on('finish', async () => {
      // 1) JSON parse
      let data;
      try { data = JSON.parse(payloadJson); }
      catch (err) {
         return res.status(400).end('Invalid JSON in payload_json');
      }

      // 2) Extract the human-readable line
      const txnText = data.extra?.message;
      if (!txnText) {
         return res.status(400).end('Missing extra.message');
      }

      // 3) Dedupe within DEDUP_WINDOW
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

      // 4) Forward to Discord
      try {
         await axios.post(
            process.env.DISCORD_WEBHOOK_URL,
            { content: txnText }
         );
         console.log('✅ Forwarded:', txnText);
         return res.sendStatus(200);
      } catch (err) {
         console.error('❌ Error sending to Discord:', err);
         return res.status(500).end('Error forwarding to Discord');
      }
   });

   // pipe the incoming request into Busboy
   req.pipe(busboy);
}
