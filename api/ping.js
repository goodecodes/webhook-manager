// api/ping.js
export default function handler(req, res) {
   // any GET or POST to /api/ping will return this
   res.status(200).json({ status: 'ok', timestamp: Date.now() });
}
