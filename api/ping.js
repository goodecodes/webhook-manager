export default function handler(req, res) {
   // test end point with any GET or POST 
   res.status(200).json({ status: 'oki', timestamp: Date.now() });
}
