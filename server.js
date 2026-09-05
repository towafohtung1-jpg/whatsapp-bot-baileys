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

function getBotReply(text) {
  const lowerText = (text || "").toLowerCase().trim();

  if (["menu", "food", "chop"].some(k => lowerText.includes(k))) {
    return `🍽 *Consty's Kitchen Menu*

*MAIN DISHES - All 1,000 CFA*

✅ Eru with Fufu or Garri: 1,000 CFA
✅ Egusi Soup with Beef & Fufu/Garri: 1,000 CFA
✅ Stewed White Beans with Rice: 1,000 CFA
✅ Fried Rice with Chicken: 1,000 CFA
✅ Turning Cocoa: 1,000 CFA

📍 Bonduma, Buea - Just after the Field Second turn left
⏰ Mon-Sat: 10 AM - 6 PM, Sun Closed
📱 MoMo / WhatsApp: 674496557`;
  }

  if (["pay", "paid", "payment", "momo", "i don pay", "don pay", "sent"].some(k => lowerText.includes(k))) {
    const m = text.match(/(\d+)/);
    const amount = m ? m[1] : "[Total]";
    return `✅ *Payment Received!*

💰 Amount: ${amount} CFA
📱 Method: Mobile Money / Cash

Thank you for your payment!
Your order is being prepared. 😊`;
  }

  if (["bill", "facture", "total", "how much"].some(k => lowerText.includes(k))) {
    const q = text.match(/(\d+)\s*plate/i);
    const qty = q ? parseInt(q[1]) : 1;
    const foodTotal = qty * 1000;
    const delivery = 500;
    const grand = foodTotal + delivery;
    return `🧾 *Consty's Kitchen - Bill*

🍲 Order: ${text}
🔢 Qty: ${qty} plate(s)
💰 Food: ${foodTotal} CFA
🛵 Delivery (Bonduma): ${delivery} CFA
━━━━━━━━━━━━
💵 *TOTAL: ${grand} CFA*

📱 Pay to: 674496557 (MoMo - Constance)
After paying, send screenshot ✅`;
  }

  if (["location", "where", "address", "bonduma"].some(k => lowerText.includes(k))) {
    return `📍 *Consty's Kitchen Location*

📌 Address: Bonduma, Buea
Just after the Field Second turn on your left
South West Region, Cameroon

📱 WhatsApp / MoMo: 674496557
⏰ 10 AM - 6 PM (Mon-Sat)`;
  }

  if (["hours", "time", "open"].some(k => lowerText.includes(k))) {
    return `⏰ *Consty's Kitchen - Opening Hours*

Monday - Saturday: 10 AM - 6 PM
Sunday: Closed

📞 Order now: 674496557`;
  }

  if (["want", "order", "plate", "eru", "egusi", "beans", "fried rice", "cocoa"].some(k => lowerText.includes(k))) {
    return `✅ *Order Received!*

🍲 Item: ${text}
💰 Price: 1,000 CFA per plate + delivery
📍 Please send:
1. Your quarter (e.g. Bonduma, Molyko)
2. Phone number

You confirm? 🙏

Type "bill" to see total, then pay to 674496557`;
  }

  return `👋 Welcome to Consty's Kitchen! 🍽
All dishes 1,000 CFA only!

1️⃣ "menu" - See menu
2️⃣ "location" - Find us (Bonduma)
3️⃣ "hours" - 10AM-6PM
4️⃣ "bill" - Get bill
5️⃣ Send screenshot when you pay

📱 674496557`;
}

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
      console.log("🔹 QR generated");
    }
    if (connection === "open") {
      connectionStatus = "connected";
      myJid = sock.user?.id || null;
      lastQRDataURL = null;
      console.log("✅ Connected:", myJid);
    } else if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      connectionStatus = "disconnected";
      myJid = null;
      if (shouldReconnect) setTimeout(startWhatsApp, 2000);
    } else if (connection === "connecting") {
      connectionStatus = "connecting";
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
    const isImage = !!msg.message?.imageMessage;

    if (isImage) {
      const reply = `✅ *Payment Screenshot Received!*

🧾 *Bill Verification*

📸 Screenshot: Received ✅
📱 MoMo: 674496557

Thank you! We are verifying your payment.
Your order is being prepared. 😊

Please type amount: e.g. "2000 CFA"`;
      await sock.sendMessage(from, { text: reply });
      return;
    }

    if (!text) return;
    const reply = getBotReply(text);
    await sock.sendMessage(from, { text: reply });
  });
}

app.get("/", (_req, res) => {
  res.type("html").send(`<html><body style="font-family:system-ui;padding:20px"><h1>🤖 Consty's Kitchen Bot</h1><p>Status: <b>${connectionStatus}</b></p><p><a href="/qr">📱 QR Code</a> | <a href="/test">💬 Test Bot</a></p><p>MoMo: 674496557</p></body></html>`);
});

app.get("/qr", (_req, res) => {
  const img = lastQRDataURL ? `<img src="${lastQRDataURL}" style="max-width:360px;border-radius:12px;" />` : `<p>No QR - Already connected.</p>`;
  res.type("html").send(`<html><head><meta charset="utf-8" /><meta http-equiv="refresh" content="5"><title>QR</title></head><body style="font-family:system-ui;display:grid;place-items:center;height:100vh"><h2>Scan: 674496557</h2>${img}<br/><a href="/">Back</a> | <a href="/test">Test</a></body></html>`);
});

app.get("/test", (_req, res) => {
  res.type("html").send(`<html><head><meta charset="utf-8"/></head><body style="font-family:system-ui;max-width:500px;margin:40px auto;padding:20px">
<h2>💬 Test Consty's Bot</h2>
<div id="chat" style="border:1px solid #ccc;border-radius:12px;height:350px;overflow-y:auto;padding:15px;background:#f9f9f9;margin-bottom:15px"></div>
<input id="input" placeholder="Try: menu, bill 2 plates eru, I don pay 2000, location" style="width:68%;padding:12px;border-radius:8px;border:1px solid #ccc"/>
<button onclick="send()" style="padding:12px 20px;border-radius:8px;background:#25D366;color:white;border:none;cursor:pointer;margin-left:5px">Send</button>
<p style="font-size:12px;color:#666;margin-top:10px">Tip: Click Send or press Enter. Screenshot = on WhatsApp only</p>
<script>
const chat=document.getElementById('chat'); const input=document.getElementById('input');
async function send(){
  const text=input.value.trim(); if(!text) return;
  chat.innerHTML+='<div style="text-align:right;margin:8px 0"><span style="background:#DCF8C6;padding:8px 12px;border-radius:12px;display:inline-block">'+text+'</span></div>';
  input.value='';
  const res=await fetch('/test-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
  const data=await res.json();
  chat.innerHTML+='<div style="text-align:left;margin:8px 0"><span style="background:white;padding:8px 12px;border-radius:12px;display:inline-block;white-space:pre-wrap;border:1px solid #eee">'+data.reply+'</span></div>';
  chat.scrollTop=chat.scrollHeight;
}
input.addEventListener('keypress', e=>{ if(e.key==='Enter') send(); });
</script>
</body></html>`);
});

app.post("/test-message", (req, res) => {
  const reply = getBotReply(req.body.text || "");
  res.json({ reply });
});

app.listen(PORT, () => console.log(`✅ Server running on :${PORT} - open /test`));
startWhatsApp().catch(err => console.error("❌ Failed:", err));
