// api/incoming.js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Busboy = require('busboy');
import axios from 'axios';

// Tell Vercel not to parse the body
export const config = { api: { bodyParser: false } };

const DEDUP_WINDOW = 1_000;      // ms
const seen = new Map();  // txnText → timestamp

export default async function handler(req, res) {
   // ─── Health check ─────────────────────────────────────────────────
   if (req.method === 'GET') {
      return res
         .status(200)
         .json({ status: '✅ incoming.js is alive', now: Date.now() });
   }

   // ─── Only accept POST ─────────────────────────────────────────────
   if (req.method !== 'POST') {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
   }
   const ct = req.headers['content-type'] || '';
   if (!ct.startsWith('multipart/form-data')) {
      return res.status(415).end('Unsupported Media Type');
   }

   // ─── Parse multipart/form-data ────────────────────────────────────
   let payloadJson = '';
   const busboy = new Busboy({ headers: req.headers });
   busboy.on('field', (name, val) => {
      if (name === 'payload_json') payloadJson = val;
   });

   busboy.on('finish', async () => {
      // 1️⃣ JSON parse
      let data;
      try {
         data = JSON.parse(payloadJson);
      } catch {
         return res.status(400).end('Invalid JSON in payload_json');
      }

      // 2️⃣ Extract the human‐readable chat line
      const txnText = data.extra?.message;
      if (!txnText) {
         return res.status(400).end('Missing extra.message');
      }

      // 3️⃣ Dedupe within window
      const now = Date.now();
      const last = seen.get(txnText) || 0;
      if (now - last < DEDUP_WINDOW) {
         console.log('↩️ Duplicate, skipping:', txnText);
         return res.sendStatus(204);
      }
      seen.set(txnText, now);
      for (const [text, ts] of seen) {
         if (now - ts > DEDUP_WINDOW) seen.delete(text);
      }

      // 4️⃣ Forward to Discord via incoming webhook
      try {
         await axios.post(process.env.DISCORD_WEBHOOK_URL, { content: txnText });
         console.log('✅ Forwarded:', txnText);
         return res.sendStatus(200);
      } catch (err) {
         console.error('❌ Error sending to Discord:', err);
         return res.status(500).end('Error forwarding to Discord');
      }
   });

   // 🔌 kick off the parser
   req.pipe(busboy);
}
