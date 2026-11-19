/**
 * WhatsApp worker (Baileys) for the WhatsApp AI Assistant app.
 *
 * Exposes exactly the endpoints the app expects:
 *   GET  /whatsapp/status?businessId=&accountId=
 *   POST /whatsapp/connect          { businessId, accountId, phoneNumber?, method }
 *   POST /whatsapp/disconnect       { businessId, accountId }
 *   POST /whatsapp/reconnect        { businessId, accountId }
 *   GET  /whatsapp/pairing-code?businessId=&accountId=&phoneNumber=
 *   GET  /whatsapp/qr?businessId=&accountId=
 *   GET  /health
 *
 * Calls back into the app:
 *   POST {APP_URL}/api/public/whatsapp/connection-state
 *   POST {APP_URL}/api/public/whatsapp/inbound-message   -> may return { reply }
 *
 * Every request in both directions carries: Authorization: Bearer <WORKER_TOKEN>
 */
import fs from "node:fs";
import path from "node:path";

import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from "@whiskeysockets/baileys";

const processedIds = new Set();
const chatQueues = new Map();
function enqueue(key, fn) {
  const run = (chatQueues.get(key) || Promise.resolve()).then(fn).catch((e) => logger?.error?.({ err: String(e) }, "queued message failed"));
  chatQueues.set(key, run);
  run.finally(() => { if (chatQueues.get(key) === run) chatQueues.delete(key); });
  return run;
}

const PORT = Number(process.env.PORT || 8088);
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";

if (!WORKER_TOKEN) {
  console.error("WORKER_TOKEN is required. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!APP_URL) {
  console.error("APP_URL is required. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/** accountId -> session */
const sessions = new Map();

function sessionDir(accountId) {
  return path.join(SESSIONS_DIR, accountId.replace(/[^a-zA-Z0-9-]/g, ""));
}

function statusOf(accountId, businessId) {
  const s = sessions.get(accountId);
  return {
    accountId,
    businessId: s?.businessId ?? businessId ?? null,
    phoneNumber: s?.phoneNumber ?? null,
    jid: s?.jid ?? null,
    displayName: s?.displayName ?? null,
    connectionState: s?.connectionState ?? "DISCONNECTED",
    lastConnectedAt: s?.lastConnectedAt ?? null,
    lastSeenAt: s?.lastSeenAt ?? null,
    lastError: s?.lastError ?? null,
  };
}

async function postToApp(pathname, body) {
  try {
    const res = await fetch(`${APP_URL}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${WORKER_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;
    if (!res.ok) logger.warn({ pathname, status: res.status, payload }, "app callback failed");
    return payload;
  } catch (error) {
    logger.error({ pathname, err: String(error) }, "app callback unreachable");
    return null;
  }
}

function reportState(session, connectionState, lastError = null) {
  session.connectionState = connectionState;
  session.lastSeenAt = new Date().toISOString();
  session.lastError = lastError;
  if (connectionState === "CONNECTED") session.lastConnectedAt = session.lastSeenAt;

  void postToApp("/api/public/whatsapp/connection-state", {
    accountId: session.accountId,
    connectionState,
    phoneNumber: session.phoneNumber,
    jid: session.jid,
    displayName: session.displayName,
    lastError,
  });
}

async function startSession({ businessId, accountId, method, phoneNumber }) {
  const existing = sessions.get(accountId);
  if (existing?.sock && existing.connectionState === "CONNECTED") return existing;
  if (existing?.starting) return existing;

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir(accountId));
  const { version } = await fetchLatestBaileysVersion();

  const session = existing ?? { accountId };
  session.businessId = businessId;
  session.starting = true;
  session.method = method || "QR";
  session.requestedPhone = phoneNumber ? String(phoneNumber).replace(/\D/g, "") : null;
  session.qr = session.qr ?? null;
  session.pairingCode = session.pairingCode ?? null;
  sessions.set(accountId, session);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.appropriate("Chrome"),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  session.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = await QRCode.toDataURL(qr).catch(() => qr);
      session.qrExpiresAt = new Date(Date.now() * 1 + 60_000).toISOString();
      if (session.connectionState !== "CONNECTING") reportState(session, "CONNECTING");
    }

    if (connection === "connecting") {
      if (session.connectionState !== "CONNECTING") reportState(session, "CONNECTING");
    }

    if (connection === "open") {
      session.starting = false;
      session.qr = null;
      session.pairingCode = null;
      session.jid = sock.user?.id ?? null;
      session.phoneNumber = sock.user?.id ? sock.user.id.split(":")[0].split("@")[0] : null;
      session.displayName = sock.user?.name ?? null;
      reportState(session, "CONNECTED");
      logger.info({ accountId }, "whatsapp connected");
    }

    if (connection === "close") {
      session.starting = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const message = lastDisconnect?.error?.message ?? null;

      if (loggedOut) {
        fs.rmSync(sessionDir(accountId), { recursive: true, force: true });
        sessions.delete(accountId);
        session.connectionState = "DISCONNECTED";
        void postToApp("/api/public/whatsapp/connection-state", {
          accountId,
          connectionState: "DISCONNECTED",
          phoneNumber: session.phoneNumber,
          jid: session.jid,
          displayName: session.displayName,
          lastError: message ?? "Logged out on the phone",
        });
        return;
      }

      reportState(session, "RECONNECTING", message);
      setTimeout(() => {
        startSession({ businessId, accountId, method: session.method, phoneNumber }).catch((e) =>
          logger.error({ err: String(e) }, "reconnect failed"),
        );
      }, 3000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        const jid = msg.key.remoteJid || "";
        const msgId = msg.key.id;
        if (msgId) {
          if (processedIds.has(msgId)) continue;
          processedIds.add(msgId);
          if (processedIds.size > 5000) processedIds.delete(processedIds.values().next().value);
        }
        if (jid.endsWith("@g.us") || jid === "status@broadcast") continue;

        const m = msg.message;
        const text =
          m.conversation ||
          m.extendedTextMessage?.text ||
          m.imageMessage?.caption ||
          m.videoMessage?.caption ||
          "";

        let messageType = "TEXT";
        if (m.imageMessage) messageType = "IMAGE";
        else if (m.audioMessage) messageType = "AUDIO";
        else if (m.videoMessage) messageType = "VIDEO";
        else if (m.documentMessage) messageType = "DOCUMENT";
        else if (m.locationMessage) messageType = "LOCATION";
        else if (!text) messageType = "OTHER";

        if (!text) continue;

        // Owner commands typed from the business phone: /takeover, /release
        if (msg.key.fromMe) {
          if (!text.trim().startsWith("/")) continue;
          await postToApp("/api/public/whatsapp/inbound-message", {
            accountId, phone: jid.split("@")[0], jid, message: text.trim(), fromMe: true,
          });
          continue;
        }

        await enqueue(`${accountId}:${jid}`, async () => {
        const result = await postToApp("/api/public/whatsapp/inbound-message", {
          accountId,
          phone: jid.split("@")[0],
          jid,
          name: msg.pushName || null,
          message: text,
          externalId: msg.key.id || null,
          messageType,
        });

        if (result?.reply) {
          await sock.sendMessage(jid, { text: String(result.reply) });
        }
        for (const m of Array.isArray(result?.media) ? result.media : []) {
          try {
            if (m?.type === "image" && m.url) {
              await sock.sendMessage(jid, { image: { url: String(m.url) }, caption: String(m.caption || "") });
            }
          } catch (e) {
            logger.error({ err: String(e) }, "media send failed");
          }
        }
        if (result?.receipt) {
          await sock.sendMessage(jid, { text: String(result.receipt) });
        }
        });
      } catch (error) {
        logger.error({ err: String(error) }, "failed handling inbound message");
      }
    }
  });

  // Pairing-code login (no QR scan) when a phone number was supplied
  if (session.method === "PAIRING_CODE" && session.requestedPhone && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(session.requestedPhone);
        session.pairingCode = code;
        session.pairingExpiresAt = new Date(Date.now() + 120_000).toISOString();
        logger.info({ accountId, code }, "pairing code issued");
      } catch (error) {
        session.lastError = String(error);
        logger.error({ err: String(error) }, "pairing code failed");
      }
    }, 3000);
  }

  return session;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.headers.authorization !== `Bearer ${WORKER_TOKEN}`) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, sessions: sessions.size }));

app.get("/whatsapp/status", (req, res) => {
  const { businessId, accountId } = req.query;
  if (!accountId) return res.status(400).json({ message: "accountId is required" });
  res.json(statusOf(String(accountId), businessId ? String(businessId) : null));
});

app.post("/whatsapp/connect", async (req, res) => {
  const { businessId, accountId, phoneNumber, method } = req.body || {};
  if (!businessId || !accountId) {
    return res.status(400).json({ message: "businessId and accountId are required" });
  }
  try {
    await startSession({ businessId, accountId, method, phoneNumber });
    res.json(statusOf(accountId, businessId));
  } catch (error) {
    logger.error({ err: String(error) }, "connect failed");
    res.status(500).json({ message: String(error) });
  }
});

app.post("/whatsapp/disconnect", async (req, res) => {
  const { accountId } = req.body || {};
  if (!accountId) return res.status(400).json({ message: "accountId is required" });
  const session = sessions.get(accountId);
  if (session?.sock) {
    try {
      await session.sock.logout();
    } catch {
      try {
        session.sock.end(undefined);
      } catch {
        /* ignore */
      }
    }
  }
  fs.rmSync(sessionDir(accountId), { recursive: true, force: true });
  sessions.delete(accountId);
  await postToApp("/api/public/whatsapp/connection-state", {
    accountId,
    connectionState: "DISCONNECTED",
    lastError: null,
  });
  res.json(null);
});

app.post("/whatsapp/reconnect", async (req, res) => {
  const { businessId, accountId } = req.body || {};
  if (!businessId || !accountId) {
    return res.status(400).json({ message: "businessId and accountId are required" });
  }
  const session = sessions.get(accountId);
  if (session?.sock) {
    try {
      session.sock.end(undefined);
    } catch {
      /* ignore */
    }
    session.sock = null;
    session.starting = false;
  }
  try {
    await startSession({ businessId, accountId, method: session?.method ?? "QR" });
    res.json(null);
  } catch (error) {
    res.status(500).json({ message: String(error) });
  }
});

app.get("/whatsapp/qr", async (req, res) => {
  const { businessId, accountId } = req.query;
  if (!businessId || !accountId) {
    return res.status(400).json({ message: "businessId and accountId are required" });
  }
  let session = sessions.get(String(accountId));
  if (!session) {
    session = await startSession({
      businessId: String(businessId),
      accountId: String(accountId),
      method: "QR",
    });
  }
  for (let i = 0; i < 20 && !session.qr && session.connectionState !== "CONNECTED"; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!session.qr) {
    return res
      .status(409)
      .json({ message: session.connectionState === "CONNECTED" ? "Already connected" : "QR not ready yet" });
  }
  res.json({ qr: session.qr, expiresAt: session.qrExpiresAt ?? null });
});

app.get("/whatsapp/pairing-code", async (req, res) => {
  const { businessId, accountId, phoneNumber } = req.query;
  if (!businessId || !accountId || !phoneNumber) {
    return res
      .status(400)
      .json({ message: "businessId, accountId and phoneNumber are required" });
  }
  let session = sessions.get(String(accountId));
  if (!session || !session.sock) {
    session = await startSession({
      businessId: String(businessId),
      accountId: String(accountId),
      method: "PAIRING_CODE",
      phoneNumber: String(phoneNumber),
    });
  }
  for (let i = 0; i < 30 && !session.pairingCode; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!session.pairingCode) {
    return res.status(409).json({ message: session.lastError || "Pairing code not ready yet" });
  }
  res.json({ code: session.pairingCode, expiresAt: session.pairingExpiresAt ?? null });
});

app.listen(PORT, () => logger.info(`WhatsApp worker listening on :${PORT} -> ${APP_URL}`));
