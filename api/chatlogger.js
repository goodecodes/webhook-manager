// /api/chatlogger.js
//
// Receives batched chat log events (JSON array), deduplicates each entry via Upstash Redis,
// then forwards only “new” messages to a Discord channel.
//
// Expected payload example (array):
// [
//   {
//     "id": 1417339442575,
//     "timestamp": "2021-01-01T00:00:00.000000000Z",
//     "chatType": "FRIENDS",
//     "chatName": "player name",
//     "sender": "player name",
//     "rank": -1,
//     "message": "Dasdasd"
//   }
// ]

import axios from "axios";
import crypto from "crypto";

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Optional config:
 * - By default, Next/Vercel body parsing is enabled (we want JSON parsing here).
 * - Do NOT disable bodyParser for this endpoint.
 */
export const config = {
   api: {
      bodyParser: true,
   },
};

function sha1(input) {
   return crypto.createHash("sha1").update(String(input)).digest("hex");
}

function toSafeString(v) {
   if (v === null || v === undefined) return "";
   return String(v);
}

function chunkArray(arr, size) {
   const out = [];
   for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
   return out;
}

/**
 * Dedupe a batch of message IDs using Upstash REST pipeline.
 * Uses: SET key 1 EX <ttl> NX
 * Returns a boolean[] where true means "duplicate" and false means "new".
 */
async function dedupeIdsAtomic(ids, scope, ttlSec) {
   if (!Array.isArray(ids) || ids.length === 0) return [];

   const upstashUrl = process.env.UPSTASH_REST_URL;
   const upstashToken = process.env.UPSTASH_REST_TOKEN;

   if (!upstashUrl || !upstashToken) {
      // If Redis isn’t configured, fail open (treat everything as new).
      console.warn("[chatlogger] Missing UPSTASH env vars, allowing all messages.");
      return ids.map(() => false);
   }

   // Build keys. Scope helps avoid collisions if you later support multiple users/clans.
   const keys = ids.map((id) => `dedupe:chatlogger:${scope}:${id}`);

   // Upstash REST pipeline expects a 2D array: [["CMD","arg1",...], ...]
   // Docs: /pipeline with [["SET", key, value, "EX", ttl, "NX"], ...]
   const commands = keys.map((key) => ["SET", key, "1", "EX", String(ttlSec), "NX"]);

   try {
      const res = await axios.post(`${upstashUrl}/pipeline`, commands, {
         headers: {
            Authorization: `Bearer ${upstashToken}`,
            "Content-Type": "application/json",
         },
         timeout: 10_000,
      });

      const results = Array.isArray(res.data) ? res.data : [];

      // Each item is like { result: "OK" } if set, or { result: null } if NX failed,
      // or { error: "..." } if something went wrong for that command.
      return results.map((r) => {
         if (r?.result === "OK") return false; // new
         if (r?.error) {
            // If a single command errors, fail open for that entry.
            console.warn("[chatlogger] Redis pipeline item error, allowing:", r.error);
            return false;
         }
         return true; // duplicate (NX failed => result null)
      });
   } catch (err) {
      console.error("[chatlogger] Redis pipeline error, fallback to allow:", err?.message);
      return ids.map(() => false);
   }
}

async function postDiscordEmbeds(embeds) {
   const channelId = process.env.CHATLOGGER_TARGET_CHANNEL_ID;
   const botToken = process.env.TEST_BOT_TOKEN;

   if (!channelId) throw new Error("Missing CHATLOGGER_TARGET_CHANNEL_ID (or TARGET_CHANNEL_ID)");
   if (!botToken) throw new Error("Missing DISCORD_BOT_TOKEN");

   // Send sequentially to be gentle on rate limits.
   for (const embed of embeds) {
      await axios.post(
         `${DISCORD_API}/channels/${channelId}/messages`,
         { embeds: [embed] },
         {
            headers: {
               Authorization: `Bot ${botToken}`,
               "Content-Type": "application/json",
            },
            timeout: 15_000,
         }
      );
   }
}

export default async function handler(req, res) {
   // Health check
   if (req.method === "GET") {
      return res.status(200).json({ alive: true, now: Date.now() });
   }

   if (req.method !== "POST") {
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
   }

   // --- Auth (recommended by the plugin README) ---
   // If you set CHATLOGGER_AUTH_TOKEN, we’ll require an exact match.
   // If you don’t set it, we’ll allow requests but still scope dedupe by header value.
   const authHeader = toSafeString(req.headers.authorization).trim();
   const expectedToken = toSafeString(process.env.CHATLOGGER_AUTH_TOKEN).trim();

   if (expectedToken) {
      if (!authHeader || authHeader !== expectedToken) {
         return res.status(401).json({ error: "Unauthorized" });
      }
   }

   // Build a stable scope for dedupe keys:
   // - If authHeader exists, hash it; else use "public".
   const scope = authHeader ? sha1(authHeader).slice(0, 12) : "public";

   // --- Validate body ---
   const body = req.body;

   if (!Array.isArray(body)) {
      return res.status(400).json({ error: "Expected JSON array body." });
   }

   // The plugin says up to 30; we’ll enforce a reasonable cap anyway.
   const rawItems = body.slice(0, 50);

   // Normalize and validate items
   const items = rawItems
      .map((m, idx) => {
         const id = m?.id;
         const message = toSafeString(m?.message).trim();
         const timestamp = toSafeString(m?.timestamp).trim();
         const chatType = toSafeString(m?.chatType).trim();
         const chatName = toSafeString(m?.chatName).trim();
         const sender = toSafeString(m?.sender).trim();

         if (id === null || id === undefined) return { _invalid: true, _idx: idx };
         if (!message) return { _invalid: true, _idx: idx };

         return {
            id: String(id),
            message,
            timestamp,
            chatType,
            chatName,
            sender,
         };
      })
      .filter((x) => !x._invalid);

   if (items.length === 0) {
      return res.status(400).json({ error: "No valid messages found in body." });
   }

   // --- Deduplicate ---
   const ttlSec = Number(process.env.CHATLOGGER_DEDUPE_TTL_SEC || 60);
   const ids = items.map((x) => x.id);

   const isDupFlags = await dedupeIdsAtomic(ids, scope, ttlSec);

   const accepted = [];
   let duplicates = 0;

   for (let i = 0; i < items.length; i++) {
      if (isDupFlags[i]) duplicates++;
      else accepted.push(items[i]);
   }

   // If all duplicates, no need to hit Discord
   if (accepted.length === 0) {
      return res.status(200).json({
         received: items.length,
         accepted: 0,
         duplicates,
         ttlSec,
      });
   }

   // --- Format + Forward to Discord ---
   // To avoid rate limits, aggregate accepted messages into embeds with a handful of lines each.
   // (Discord embed description limit is 4096 chars; we also keep line counts conservative.)
   const lines = accepted.map((m) => {
      const metaParts = [];
      if (m.chatType) metaParts.push(m.chatType);
      if (m.chatName) metaParts.push(m.chatName);
      const meta = metaParts.length ? ` (${metaParts.join(" • ")})` : "";

      const who = m.sender ? m.sender : "Unknown";
      const when = m.timestamp ? ` — ${m.timestamp}` : "";
      return `**${who}**${meta}${when}\n${m.message}`;
   });

   const lineChunks = chunkArray(lines, 6); // 6 messages per embed keeps descriptions short & readable

   const embeds = lineChunks.map((chunk, i) => ({
      title: i === 0 ? "Chat Logger" : "Chat Logger (cont.)",
      description: chunk.join("\n\n"),
      color: 0x3498db,
      footer: {
         text: `Deduped via Redis • TTL ${ttlSec}s • ${accepted.length}/${items.length} accepted`,
      },
      timestamp: new Date().toISOString(),
   }));

   try {
      await postDiscordEmbeds(embeds);

      return res.status(200).json({
         received: items.length,
         accepted: accepted.length,
         duplicates,
         ttlSec,
      });
   } catch (err) {
      console.error("[chatlogger] Discord send error status:", err.response?.status);
      console.error("[chatlogger] Discord send error data:", err.response?.data);
      console.error(err?.stack || err);

      const status = err.response?.status || 502;
      const data = err.response?.data || "Unknown error";
      return res.status(status).json({ error: data });
   }
}

