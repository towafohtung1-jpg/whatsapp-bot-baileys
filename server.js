import express from "express";
import cors from "cors";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || "./sessions/default";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || "default";

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let lastQRDataURL = null;
let connectionStatus = "disconnected";
let myJid = null;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["Chrome", "Linux", "128.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // When QR code is generated
    if (qr) {
      lastQRDataURL = await qrcode.toDataURL(qr);
      console.log("🔹 QR generated, sending to Supabase...");

      if (supabase) {
        const { error } = await supabase.from("sessões_do_whatsapp").upsert({
          id_do_usuário: DEFAULT_USER_ID,
          qr_code: qr,
          status: "connecting",
          atualização: new Date().toISOString()
        });
        if (error) console.error("❌ Error saving QR to Supabase:", error);
        else console.log("✅ QR saved to Supabase!");
      }
    }

    // When connection is established
    if (connection === "open") {
      connectionStatus = "connected";
      myJid = sock.user?.id || null;
      const phoneNumber = myJid?.split("@")[0]?.replace(/\D/g, "") || null;
      console.log("✅ WhatsApp connected as:", myJid);
      lastQRDataURL = null;

      if (supabase) {
        const { error } = await supabase.from("sessões_do_whatsapp").upsert({
          id_do_usuário: DEFAULT_USER_ID,
          status: "connected",
          jid: myJid,
          número: phoneNumber,
          atualização: new Date().toISOString()
        });
        if (error) console.error("❌ Error saving status:", error);
        else console.log(`✅ Status 'connected' saved to Supabase! Number: ${phoneNumber}`);
      }
    }

    // When connection is closed
    else if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.error("🔌 Connection closed. Reconnect?", shouldReconnect);
      connectionStatus = "disconnected";
      myJid = null;

      if (supabase) {
        const { error } = await supabase.from("sessões_do_whatsapp").upsert({
          id_do_usuário: DEFAULT_USER_ID,
          status: "disconnected",
          atualização: new Date().toISOString()
        });
        if (error) console.error("Error updating status in Supabase:", error);
      }

      if (shouldReconnect) setTimeout(startWhatsApp, 2000);
    }

    else if (connection === "connecting") {
      connectionStatus = "connecting";
    }
  });

  // =============================================
  // RECEIVE MESSAGES - CONSTY'S KITCHEN
  // =============================================
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.imageMessage?.caption
      || "";

    if (!text) return;
    
    const lowerText = text.toLowerCase().trim();
    console.log("📩", from, "→", lowerText);

    // =============================================
    // KEYWORD AUTO-REPLIES
    // =============================================

    // MENU Reply
    if (lowerText === "menu" || lowerText === "menu" || lowerText === "1") {
      const menuReply = `🍽️ *Consty's Kitchen Menu*

*MAIN DISHES*
- Poulet DG: 2,500 CFA
- Poulet Braisé: 2,000 CFA
- Fish with Plantains: 2,200 CFA
- Ndolé: 2,500 CFA
- Eru: 2,500 CFA
- Koki: 1,800 CFA
- Mbolo: 2,500 CFA
- Fried Chicken: 1,800 CFA

*SIDES*
- Fried Plantains: 800 CFA
- Fried Rice: 1,200 CFA
- White Rice: 1,000 CFA
- Beans: 1,500 CFA
- Fries: 800 CFA

*DRINKS*
- Bissap: 500 CFA
- Ginger Juice: 500 CFA
- Zobo: 500 CFA
- Mineral Water: 500 CFA
- Soft Drink: 500 CFA

📍 To order, just tell me what you'd like!
💰 Delivery available in Buea`;

      await sock.sendMessage(from, { text: menuReply });
      return;
    }

    // LOCATION Reply
    if (lowerText === "location" || lowerText === "location" || lowerText === "2") {
      await sock.sendMessage(from, { 
        text: `📍 *Consty's Kitchen Location*

📌 Address: [Street Name], Molyko, Buea
Opposite Total Filling Station
South West Region, Cameroon

🗣️ Landmark: Near the roundabout`
      });
      return;
    }

    // HOURS Reply
    if (lowerText === "hours" || lowerText === "hours" || lowerText === "3") {
      await sock.sendMessage(from, { 
        text: `⏰ *Consty's Kitchen - Opening Hours*

Monday - Saturday: 10 AM - 10 PM
Sunday: Closed

📞 For special orders: +237 [Constance's number]`
      });
      return;
    }

    // ORDER Reply
    if (lowerText === "order" || lowerText === "order" || lowerText === "4") {
      await sock.sendMessage(from, { 
        text: `📝 *How to Order*

1️⃣ Tell me what you'd like from the menu
2️⃣ Provide your delivery location
3️⃣ Confirm your order
4️⃣ Pay via Mobile Money: +237 [Constance's number]

✅ Your food will be prepared fresh and delivered hot!`
      });
      return;
    }

    // =============================================
    // DEFAULT REPLY (when no keyword matches)
    // =============================================
    await sock.sendMessage(from, { 
      text: `👋 Welcome to Consty's Kitchen!

Reply with:
1️⃣ "menu" - to see our full menu
2️⃣ "location" - to find us
3️⃣ "hours" - to see our opening times
4️⃣ "order" - to place an order

We're here to serve you! 😊`
    });
  });
}

// 🌐 HTTP Routes
app.get("/", (_req, res) => {
  res.type("html").send(`
    <html>
      <head><meta charset="utf-8" /></head>
      <body style="font-family: system-ui; padding: 20px">
        <h1>🤖 Consty's Kitchen WhatsApp Bot</h1>
        <p>Status: <b>${connectionStatus}</b></p>
        <p>My JID: <code>${myJid ?? "-"}</code></p>
        <p><a href="/qr">📱 Open QR Code</a></p>
      </body>
    </html>
  `);
});

app.get("/qr", (_req, res) => {
  const img = lastQRDataURL
    ? `<img src="${lastQRDataURL}" style="max-width:360px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.15)" />`
    : `<p>No QR available. Already connected.</p>`;
  res.type("html").send(`
    <html>
      <head><meta charset="utf-8" /><meta http-equiv="refresh" content="5"><title>QR Code – Consty's Kitchen</title></head>
      <body style="font-family:system-ui;display:grid;place-items:center;height:100vh">
        <h2>Scan this QR with WhatsApp</h2>
        ${img}
        <p style="color:#666">Auto-refreshes every 5 seconds</p>
        <a href="/">Back</a>
      </body>
    </html>
  `);
});

// Send messages manually via POST
app.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!sock) return res.status(400).json({ ok: false, error: "Socket unavailable" });
    if (!to || !message) return res.status(400).json({ ok: false, error: "Provide 'to' and 'message'" });
    await sock.sendMessage(to.includes("@s.whatsapp.net") ? to : (to + "@s.whatsapp.net"), { text: message });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => console.log(`✅ HTTP server running on port :${PORT}`));

startWhatsApp().catch(err => console.error("❌ Failed to start WhatsApp:", err));
