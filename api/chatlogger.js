// /api/chatlogger.js
//
// Receives batched chat log events (JSON array), deduplicates each entry via Upstash Redis,
// then forwards only “new” messages to a Discord channel.
//
// Hybrid dedupe:
//  1) ID dedupe (covers retries/replays)                    -> TTL default 60s
//  2) Content-signature dedupe (covers multi-client dupes)  -> TTL default 10s
//
// IMPORTANT CHANGE:
// Content signature NO LONGER uses a time bucket. The TTL itself is the time window.

import axios from "axios";
import crypto from "crypto";

const DISCORD_API = "https://discord.com/api/v10";

export const config = {
   api: { bodyParser: true },
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

function normalizeForSig(s) {
   // Lowercase + trim + collapse whitespace to reduce cosmetic mismatches across clients
   return toSafeString(s).toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Normalize RuneLite nanosecond-precision ISO timestamps to millisecond precision.
 * Example:
 *   2026-01-07T00:29:10.750931200Z  ->  2026-01-07T00:29:10.750Z
 */
function normalizeIsoTimestamp(timestampIso) {
   const s = toSafeString(timestampIso).trim();
   if (!s) return "";

   // If we have ".<fraction>Z" truncate/pad fraction to 3 digits (ms)
   return s.replace(/\.(\d{1,})Z$/, (match, frac) => {
      const ms = frac.slice(0, 3).padEnd(3, "0");
      return `.${ms}Z`;
   });
}

/**
 * Hybrid dedupe (ID + content signature) in one Upstash pipeline call.
 * Returns a boolean[] where true means "duplicate" and false means "new".
 *
 * Accept rule:
 *  - Accept only if BOTH id-key and content-key are "OK" (set successfully).
 *  - If any command errors for an item, fail-open for that item (allow it).
 */
async function dedupeMessagesAtomic(items, scope, idTtlSec, contentTtlSec) {
   if (!Array.isArray(items) || items.length === 0) return [];

   const upstashUrl = process.env.UPSTASH_REST_URL;
   const upstashToken = process.env.UPSTASH_REST_TOKEN;

   if (!upstashUrl || !upstashToken) {
      console.warn("[chatlogger] Missing UPSTASH env vars, allowing all messages.");
      return items.map(() => false);
   }

   const idKeys = items.map((m) => `dedupe:chatlogger:id:${scope}:${m.id}`);

   // Content signature catches multi-client duplicates where IDs differ.
   // IMPORTANT: no time bucket here — TTL is the time window.
   const contentKeys = items.map((m) => {
      const sig = [
         normalizeForSig(m.chatType),
         normalizeForSig(m.chatName),
         normalizeForSig(m.sender),
         normalizeForSig(m.message),
      ].join("|");

      return `dedupe:chatlogger:content:${scope}:${sha1(sig)}`;
   });

   // Build one pipeline with 2 commands per item: [ID set NX] then [CONTENT set NX]
   const commands = [];
   for (let i = 0; i < items.length; i++) {
      commands.push(["SET", idKeys[i], "1", "EX", String(idTtlSec), "NX"]);
      commands.push(["SET", contentKeys[i], "1", "EX", String(contentTtlSec), "NX"]);
   }

   try {
      const res = await axios.post(`${upstashUrl}/pipeline`, commands, {
         headers: {
            Authorization: `Bearer ${upstashToken}`,
            "Content-Type": "application/json",
         },
         timeout: 10_000,
      });

      const results = Array.isArray(res.data) ? res.data : [];

      // Reconstruct per-item decision from pairs of results
      const dupFlags = [];
      for (let i = 0; i < items.length; i++) {
         const idResult = results[i * 2];
         const contentResult = results[i * 2 + 1];

         const idErrored = !!idResult?.error;
         const contentErrored = !!contentResult?.error;

         if (idErrored || contentErrored) {
            console.warn("[chatlogger] Redis pipeline item error(s), allowing:", {
               idError: idResult?.error,
               contentError: contentResult?.error,
            });
            dupFlags.push(false); // fail open
            continue;
         }

         const idOk = idResult?.result === "OK";
         const contentOk = contentResult?.result === "OK";

         // Strict: accept only if both are new
         const isDuplicate = !(idOk && contentOk);
         dupFlags.push(isDuplicate);
      }

      return dupFlags;
   } catch (err) {
      console.error("[chatlogger] Redis pipeline error, fallback to allow:", err?.message);
      return items.map(() => false);
   }
}

async function postDiscordEmbeds(embeds) {
   const channelId = process.env.CHATLOGGER_TARGET_CHANNEL_ID;
   const botToken = process.env.DISCORD_BOT_TOKEN;

   // Match your intent: no fallback + test bot token
   if (!channelId) throw new Error("Missing CHATLOGGER_TARGET_CHANNEL_ID");
   if (!botToken) throw new Error("Missing TEST_BOT_TOKEN");

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

   // --- Auth ---
   const authHeader = toSafeString(req.headers.authorization).trim();
   const expectedToken = toSafeString(process.env.CHATLOGGER_AUTH_TOKEN).trim();

   if (expectedToken) {
      if (!authHeader || authHeader !== expectedToken) {
         return res.status(401).json({ error: "Unauthorized" });
      }
   }

   // Namespace scope (used to avoid collisions across tokens)
   // IMPORTANT: derive from expectedToken when present so it's stable across clients
   const scope = expectedToken
      ? sha1(expectedToken).slice(0, 12)
      : authHeader
         ? sha1(authHeader).slice(0, 12)
         : "public";

   // --- Validate body ---
   const body = req.body;
   if (!Array.isArray(body)) {
      return res.status(400).json({ error: "Expected JSON array body." });
   }

   const rawItems = body.slice(0, 50);

   const items = rawItems
      .map((m, idx) => {
         const id = m?.id;
         const message = toSafeString(m?.message).trim();
         const timestamp = normalizeIsoTimestamp(m?.timestamp);
         const chatType = toSafeString(m?.chatType).trim();
         const chatName = toSafeString(m?.chatName).trim();
         const sender = toSafeString(m?.sender).trim();
         const rank = Number.isInteger(m?.rank) ? m.rank : m?.rank ?? null;

         if (id === null || id === undefined) return { _invalid: true, _idx: idx };
         if (!message) return { _invalid: true, _idx: idx };

         return {
            id: String(id),
            message,
            timestamp,
            chatType,
            chatName,
            sender,
            rank
         };
      })
      .filter((x) => !x._invalid);

   const filteredItems = items.filter((m) => m.rank !== -2);

   /** micro-polish */
   //    const filteredItems = items.filter(
   //   (m) => !(m.chatType === "CLAN" && m.rank === -2)
   // );


   console.log(
      "[chatlogger] incoming ids:",
      filteredItems.map((m) => ({
         id: m.id,
         sender: m.sender,
         message: m.message,
         rank: m.rank,
         timestamp: m.timestamp,
      }))
   );



   if (filteredItems.length === 0) {
      return res.status(400).json({ error: "No valid messages found in body." });
   }

   // --- Dedupe settings ---
   const idTtlSec = Number(process.env.CHATLOGGER_DEDUPE_TTL_SEC || 60);

   // Content dedupe window should be short (just to catch multi-client near-simultaneous dupes)
   const contentTtlSec = Number(process.env.CHATLOGGER_CONTENT_TTL_SEC || 10);

   // --- Deduplicate (hybrid) ---
   const isDupFlags = await dedupeMessagesAtomic(filteredItems, scope, idTtlSec, contentTtlSec);

   const accepted = [];
   let duplicates = 0;

   for (let i = 0; i < filteredItems.length; i++) {
      if (isDupFlags[i]) duplicates++;
      else accepted.push(filteredItems[i]);
   }

   if (accepted.length === 0) {
      return res.status(200).json({
         received: filteredItems.length,
         accepted: 0,
         duplicates,
         idTtlSec,
         contentTtlSec,
      });
   }

   // --- Format + Forward ---
   const lines = accepted.map((m) => {
      const who = m.sender ? m.sender : "Unknown";
      return `**${who}:** ${m.message}`;
   });

   const lineChunks = chunkArray(lines, 6);

   const embeds = lineChunks.map((chunk) => ({
      description: chunk.join("\n\n"),
      color: 0x3498db,
   }));

   try {
      await postDiscordEmbeds(embeds);

      return res.status(200).json({
         received: filteredItems.length,
         accepted: accepted.length,
         duplicates,
         idTtlSec,
         contentTtlSec,
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

