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

const supabase = (SUPABASE_URL && SUPABASE_KEY)? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

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
    if (qr) {
      lastQRDataURL = await qrcode.toDataURL(qr);
      console.log("🔹 QR generated, sending to Supabase...");
      if (supabase) {
        await supabase.from("sessões_do_whatsapp").upsert({
          id_do_usuário: DEFAULT_USER_ID,
          qr_code: qr,
          status: "connecting",
          atualização: new Date().toISOString()
        });
      }
    }
    if (connection === "open") {
      connectionStatus = "connected";
      myJid = sock.user?.id || null;
      console.log("✅ WhatsApp connected as:", myJid);
      lastQRDataURL = null;
      if (supabase) {
        const phoneNumber = myJid?.split("@")[0]?.replace(/\D/g, "") || null;
        await supabase.from("sessões_do_whatsapp").upsert({
          id_do_usuário: DEFAULT_USER_ID,
          status: "connected",
          jid: myJid,
          número: phoneNumber,
          atualização: new Date().toISOString()
        });
      }
    }
    else if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode!== DisconnectReason.loggedOut;
      console.error("🔌 Connection closed. Reconnect?", shouldReconnect);
      connectionStatus = "disconnected";
      myJid = null;
      if (shouldReconnect) setTimeout(startWhatsApp, 2000);
    }
    else if (connection === "connecting") connectionStatus = "connecting";
  });

  // RECEIVE MESSAGES
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe) return;
    const from = msg.key.remoteJid;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
    if (!text) return;
    const lowerText = text.toLowerCase().trim();
    console.log("📩", from, "→", lowerText);

    // MENU
    if (["menu","1","food","chop","what do you have"].some(k => lowerText.includes(k))) {
      const menuReply = `🍽 *Consty's Kitchen Menu*

*MAIN DISHES - All 1,000 CFA*

✅ Eru with Fufu or Garri: 1,000 CFA
✅ Egusi Soup with Beef & Fufu/Garri: 1,000 CFA
✅ Stewed White Beans with Rice: 1,000 CFA
✅ Fried Rice with Chicken: 1,000 CFA
✅ Turning Cocoa: 1,000 CFA

📍 Location: Bonduma, Buea
💰 To order: "I want Eru 2 plates to Bonduma"
📱 MoMo: 674496557 (Constance)`;
      await sock.sendMessage(from, { text: menuReply });
      return;
    }

    // PAYMENT - YOUR TEMPLATE
    if (["pay","paid","payment","momo","orange money","mtn","i don pay","don pay","done pay","i have sent","sent"].some(k => lowerText.includes(k))) {
      const amountMatch = text.match(/(\d+[\.,]?\d*)\s*(cfa|frs|k)?/i);
      const amount = amountMatch? amountMatch[1] : "[Total]";
      const paymentReply = `✅ *Payment Received!*

💰 Amount: ${amount} CFA
📱 Method: Mobile Money / Cash

Thank you for your payment!
Your order is being prepared. 😊`;
      await sock.sendMessage(from, { text: paymentReply });
      return;
    }

    // ORDER
    if (["want","order","plate","buy","eru","egusi","beans","fried rice","cocoa"].some(k => lowerText.includes(k))) {
      const orderReply = `✅ *Order Received!*

🍲 Item: ${text}
💰 Price: 1,000 CFA per plate + delivery

📍 Please send:
1. Your quarter (e.g. Bonduma, Molyko)
2. Phone number

You confirm? 🙏`;
      await sock.sendMessage(from, { text: orderReply });
      return;
    }

    // LOCATION
    if (["location","where","address","2","bonduma"].some(k => lowerText.includes(k))) {
      await sock.sendMessage(from, { text: `📍 *Consty's Kitchen Location*

📌 Address: Bonduma, Buea
Just after the Field Second turn on your left
South West Region, Cameroon

📱 WhatsApp / MoMo: 674496557` });
      return;
    }

    // HOURS
    if (["hours","time","open","close","3"].some(k => lowerText.includes(k))) {
      await sock.sendMessage(from, { text: `⏰ *Consty's Kitchen - Opening Hours*

Monday - Saturday: 10 AM - 6 PM
Sunday: Closed

📞 Order now: 674496557` });
      return;
    }

    // DELIVERY
    if (["delivery","rider","track","where my food"].some(k => lowerText.includes(k))) {
      await sock.sendMessage(from, { text: `🛵 *Out for Delivery!*

Your order dey road now!
Rider will call you soon.

📞 Contact: 674496557` });
      return;
    }

    // DEFAULT
    await sock.sendMessage(from, {
      text: `👋 Welcome to Consty's Kitchen! 🍽

All dishes 1,000 CFA only!

Reply:
1️⃣ "menu" - See menu
2️⃣ "location" - Find us (Bonduma)
3️⃣ "hours" - Opening times (10AM-6PM)
4️⃣ Tell us what you want - e.g "Eru 2 plates"

📱 674496557` });
  });
}

app.get("/", (_req, res) => {
  res.type("html").send(`<html><head><meta charset="utf-8" /></head><body style="font-family: system-ui; padding: 20px"><h1>🤖 Consty's Kitchen Bot</h1><p>Status: <b>${connectionStatus}</b></p><p><a href="/qr">📱 Open QR Code</a></p><p>MoMo: 674496557</p></body></html>`);
});
app.get("/qr", (_req, res) => {
  const img = lastQRDataURL? `<img src="${lastQRDataURL}" style="max-width:360px;border-radius:12px;" />` : `<p>No QR - Already connected.</p>`;
  res.type("html").send(`<html><head><meta charset="utf-8" /><meta http-equiv="refresh" content="5"><title>QR - Consty</title></head><body style="font-family:system-ui;display:grid;place-items:center;height:100vh"><h2>Scan with WhatsApp: 674496557</h2>${img}<p>Auto-refresh 5s</p><a href="/">Back</a></body></html>`);
});

app.listen(PORT, () => console.log(`✅ HTTP server running on port :${PORT}`));
startWhatsApp().catch(err => console.error("❌ Failed to start:", err));