//// api/incoming.js
//import serverless from 'serverless-http';
//import express from 'express';
//import multer from 'multer';
//import axios from 'axios';

//const app = express();
//const upload = multer();
//const DEDUP_WINDOW = 1000;        // 1-second window
//const seen = new Map();   // in-memory dedupe

//// Tell Vercel not to parse body (we need raw multipart)
//export const config = { api: { bodyParser: false } };

//// health‐check endpoint
//app.get('/', (_req, res) => {
//   return res.status(200).send('✅ Function is up and running');
//});

//app.post('/', upload.none(), async (req, res) => {
//   let payload;
//   try {
//      payload = JSON.parse(req.body.payload_json);
//   } catch {
//      return res.sendStatus(400);
//   }

//   const txnText = payload.extra?.message;
//   if (!txnText) return res.sendStatus(400);

//   const now = Date.now();
//   if ((seen.get(txnText) || 0) + DEDUP_WINDOW > now) {
//      console.log('↩️ Duplicate, skipping:', txnText);
//      return res.sendStatus(204);
//   }
//   seen.set(txnText, now);
//   // prune old keys
//   for (const [text, ts] of seen) {
//      if (now - ts > DEDUP_WINDOW) seen.delete(text);
//   }

//   console.log('✅ Forwarding via webhook:', txnText);
//   try {
//      await axios.post(process.env.DISCORD_WEBHOOK_URL, { content: txnText });
//      console.log('   ↪️ Sent');
//   } catch (err) {
//      console.error('   ❌ Failed to send:', err);
//   }
//   res.sendStatus(200);
//});

//export default serverless(app);

//export default function handler(req, res) {
//   res.status(200).json({ message: '👋 incoming.js is alive!' });
//}
// api/incoming.js
//import serverless from 'serverless-http';
//import express from 'express';

//const app = express();

//// Disable Vercel’s default body parser so Express can handle raw bodies if needed
//export const config = { api: { bodyParser: false } };

//// 1️⃣ Health check via Express
//app.get('/', (_req, res) => {
//   return res
//      .status(200)
//      .json({ message: '✅ Express is up!' });
//});

//// 2️⃣ Simple POST echo
//app.post('/', express.text(), (req, res) => {
//   // echo back whatever body you sent
//   return res
//      .status(200)
//      .json({ message: 'POST received', body: req.body });
//});

//export default serverless(app);

// api/incoming.js

export default function handler(req, res) {
   if (req.method === 'GET') {
      return res
         .status(200)
         .json({ message: '✅ incoming.js is alive via native handler!' });
   }

   if (req.method === 'POST') {
      // echo back whatever you sent
      return res
         .status(200)
         .json({ message: '📬 POST received', headers: req.headers });
   }

   // method not allowed
   res.setHeader('Allow', ['GET', 'POST']);
   return res.status(405).end(`Method ${req.method} Not Allowed`);
}
