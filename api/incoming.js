const serverless = require('serverless-http');
const express = require('express');
const multer = require('multer');
const axios = require('axios');

const app = express();
const upload = multer();
const DEDUP_WINDOW = 1000;        // 1-second window
const seen = new Map();   // in-memory dedupe

// Tell Vercel not to parse body (we need raw multipart)
export const config = { api: { bodyParser: false } };

// api/health.js
export default function handler(req, res) {
   res.status(200).send('OK');
}


app.post('/', upload.none(), async (req, res) => {
   // 1) Log what Vercel actually sees
   console.log('🔍 Headers:', req.headers['content-type']);
   console.log('🔍 Body fields:', req.body);

   let payload;
   try {
      payload = JSON.parse(req.body.payload_json);
   } catch (err) {
      console.error('❌ JSON parse failed:', err);
      return res.sendStatus(400);
   }

   // 2) Verify your WEBHOOK URL is present
   console.log('🔗 Webhook URL:', process.env.DISCORD_WEBHOOK_URL);

   const txnText = payload.extra?.message;
   if (!txnText) {
      console.log('❌ No extra.message found');
      return res.sendStatus(400);
   }

   // existing dedupe logic…

   console.log('✅ Forwarding via webhook:', txnText);
   try {
      const resp = await axios.post(process.env.DISCORD_WEBHOOK_URL, { content: txnText });
      console.log(`   ↪️ Discord responded ${resp.status}`);
   } catch (err) {
      console.error('   ❌ Failed to send:', err.response?.status, err.response?.data || err);
   }

   res.sendStatus(200);
});


module.exports = serverless(app);