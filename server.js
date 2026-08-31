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

// ===== SMART DICTIONARY - FIX CUSTOMER MISTAKES =====
const MENU_DB = {
  "eru": { id: "1", name: "Eru with Fufu or Garri", price: 1000, keys: ["eru", "eruh", "ero", "fufu eru", "1", "eru fufu"] },
  "egusi": { id: "2", name: "Egusi Soup with Beef & Fufu/Garri", price: 1000, keys: ["egusi", "egwusi", "egousi", "egusi soup", "beef", "2", "egussi"] },
  "beans": { id: "3", name: "Stewed White Beans with Rice", price: 1000, keys: ["beans", "white beans", "rice and beans", "bean", "3", "haricot", "white"] },
  "fried rice": { id: "4", name: "Fried Rice with Chicken", price: 1000, keys: ["fried rice", "friedrice", "fried", "chicken", "4", "fry rice"] },
  "cocoa": { id: "5", name: "Turning Cocoa", price: 1000, keys: ["cocoa", "turning", "kati", "5", "turing", "turning cocoa"] },
};

const LOCATION_DB = {
  "bonduma": { fee: 300, keys: ["bonduma", "bonda", "bondma", "bondouma", "bonduma field"] },
  "molyko": { fee: 500, keys: ["molyko", "molyco", "moleko", "moly", "malyko", "molyko buea"] },
  "malingo": { fee: 500, keys: ["malingo", "maligo", "malingo street"] },
  "muea": { fee: 500, keys: ["muea", "muéa", "muea market"] },
  "checkpoint": { fee: 500, keys: ["checkpoint", "check point", "check"] },
  "buea town": { fee: 700, keys: ["buea town", "buea", "town", "bueatown"] },
  "soppo": { fee: 700, keys: ["soppo", "great soppo", "small soppo"] },
};

function correctMenu(text) {
  const lower = text.toLowerCase();
  for (let key in MENU_DB) {
    for (let alias of MENU_DB[key].keys) {
      if (lower.includes(alias)) return MENU_DB[key];
    }
  }
  return null;
}

function correctLocation(text) {
  const lower = text.toLowerCase();
  for (let loc in LOCATION_DB) {
    for (let alias of LOCATION_DB[loc].keys) {
      if (lower.includes(alias)) return { name: loc,...LOCATION_DB[loc] };
    }
  }
  return null;
}

function getBotReply(text) {
  const lowerText = (text || "").toLowerCase().trim();
  if (!lowerText) return null;

  // 1. CATALOG MENU
  if (["menu", "food", "chop", "catalog", "catelog", "list", "plate"].some(k => lowerText.includes(k))) {
    return `🍽 *Consty's Kitchen Catalog - All 1,000 CFA* 🍲

*MAIN DISHES:*
1️⃣ Eru with Fufu or Garri - 1,000 CFA
2️⃣ Egusi Soup with Beef & Fufu/Garri - 1,000 CFA
3️⃣ Stewed White Beans with Rice - 1,000 CFA
4️⃣ Fried Rice with Chicken - 1,000 CFA
5️⃣ Turning Cocoa - 1,000 CFA

👉 *How to order:*
Type number e.g. "1" or name e.g. "eru"
Or "2 plates eru + 1 fried rice"

📍 Bonduma, Just after Field 2nd left
⏰ Mon-Sat 10AM-6PM | Sun Closed
📱 MoMo / WhatsApp: 674496557`;
  }

  // 2. LOCATION CORRECTION
  const possibleLoc = correctLocation(lowerText);
  if (possibleLoc && lowerText.split(" ").length <= 4) {
    return `📍 Got it! You mean *${possibleLoc.name.toUpperCase()}* right? ✅

🛵 Delivery fee to ${possibleLoc.name}: *${possibleLoc.fee} CFA*
Food: 1,000 CFA per plate

Type *YES* to confirm ${possibleLoc.name}, or send your full quarter.

Also tell us what you want to eat. Type "menu"`;
  }

  // 3. MENU CORRECTION - MAIN SMART PART
  const dish = correctMenu(lowerText);
  if (dish) {
    const qtyMatch = lowerText.match(/(\d+)\s*plate/);
    const qty = qtyMatch? parseInt(qtyMatch[1]) : 1;
    const locFound = correctLocation(lowerText);
    const deliveryFee = locFound? locFound.fee : 500;
    const total = (qty * dish.price) + deliveryFee;

    return `✅ *Order corrected & Received!* 🍲

You typed "${text}"
→ I think you mean: *${dish.name}* ✅

🔢 Qty: ${qty} plate(s) x ${dish.price} = ${qty * dish.price} CFA
${locFound? `📍 Location: ${locFound.name} (${deliveryFee} CFA)` : `🛵 Delivery: ~${deliveryFee} CFA (tell us your quarter)`}
━━━━━━━━━━━━
💵 *TOTAL ~ ${total} CFA*

To confirm, send:
1. Your quarter (e.g. Molyko)
2. Phone number

Type "YES" to confirm ${dish.name}`;
  }

  if (["pay", "paid", "payment", "momo", "i don pay", "don pay", "sent"].some(k => lowerText.includes(k))) {
    const m = text.match(/(\d+)/);
    const amount = m? m[1] : "[Total]";
    return `✅ *Payment Received!*\n💰 Amount: ${amount} CFA\n📱 Method: MoMo 674496557\n\nThank you! Your order is being prepared. 😊`;
  }

  if (["bill", "facture", "total", "how much"].some(k => lowerText.includes(k))) {
    const q = text.match(/(\d+)\s*plate/i);
    const qty = q? parseInt(q[1]) : 1;
    const foundLoc = correctLocation(lowerText) || { fee: 500, name: "Buea" };
    const foodTotal = qty * 1000;
    const grand = foodTotal + foundLoc.fee;
    return `🧾 *Consty's Kitchen - Bill*\n\n🍲 Order: ${text}\n🔢 Qty: ${qty}\n💰 Food: ${foodTotal} CFA\n🛵 Delivery (${foundLoc.name}): ${foundLoc.fee} CFA\n━━━━━━━━━━━━\n💵 *TOTAL: ${grand} CFA*\n\n📱 Pay to: 674496557 (MoMo - Constance)\nAfter paying, type "I don pay ${grand}"`;
  }

  if (["location", "where", "address", "bonduma", "deliver"].some(k => lowerText.includes(k))) {
    return `📍 *Consty's Kitchen Location*\n\n📌 Bonduma, Buea - Just after Field 2nd left\nSouth West, Cameroon\n\nDelivery fees:\nBonduma 300F\nMolyko/Malingo/Muea 500F\nBuea Town/Soppo 700F\n\n📱 674496557\n⏰ 10AM-6PM Mon-Sat`;
  }

  if (["hours", "time", "open"].some(k => lowerText.includes(k))) {
    return `⏰ *Opening Hours*\nMon-Sat: 10 AM - 6 PM\nSunday: Closed\n📞 674496557`;
  }

  // Fallback typo suggestion
  if (lowerText.length > 2 && lowerText.length < 15) {
    return `🤔 Small typo? Did you mean:\n\n1️⃣ Eru\n2️⃣ Egusi\n3️⃣ White Beans\n4️⃣ Fried Rice\n5️⃣ Turning Cocoa\n\nOr a quarter like Molyko, Malingo?\nType "menu" for full catalog.`;
  }

  return `👋 Welcome to Consty's Kitchen! 🍽\nAll dishes 1,000 CFA only!\n\nType:\n"menu" - See catalog\n"eru" / "egusi" etc - Order (I correct mistakes 😊)\n"molyko" - Set location\n\n📱 674496557`;
}

// ===== WhatsApp Connection (same as yours) =====
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: ["Chrome", "Linux", "128.0"] });
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
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut;
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
    const isImage =!!msg.message?.imageMessage;
    if (isImage) {
      const reply = `✅ *Payment Screenshot Received!*\n📸 Received ✅\n📱 MoMo: 674496557\n\nWe are verifying. Please type amount: e.g. "2000 CFA"`;
      await sock.sendMessage(from, { text: reply });
      return;
    }
    if (!text) return;
    const reply = getBotReply(text);
    if (reply) await sock.sendMessage(from, { text: reply });
  });
}

app.get("/", (_req, res) => {
  res.type("html").send(`<html><body style="font-family:system-ui;padding:20px"><h1>🤖 Consty's Kitchen Bot SMART v2 ✅</h1><p>Status: <b>${connectionStatus}</b></p><p><a href="/qr">📱 QR Code</a> | <a href="/test">💬 Test Bot</a></p><p>Now corrects typos! Try erru, molyco, friedrice</p></body></html>`);
});
app.get("/qr", (_req, res) => {
  const img = lastQRDataURL? `<img src="${lastQRDataURL}" style="max-width:360px;border-radius:12px;" />` : `<p>No QR - Already connected ✅.</p>`;
  res.type("html").send(`<html><head><meta charset="utf-8" /><meta http-equiv="refresh" content="5"><title>QR</title></head><body style="font-family:system-ui;display:grid;place-items:center;height:100vh"><h2>Scan: 674496557</h2>${img}<br/><a href="/">Back</a> | <a href="/test">Test</a></body></html>`);
});
app.get("/test", (_req, res) => {
  res.type("html").send(`<html><head><meta charset="utf-8"/></head><body style="font-family:system-ui;max-width:500px;margin:40px auto;padding:20px">
<h2>💬 Test SMART Bot - Try typos!</h2>
<div id="chat" style="border:1px solid #ccc;border-radius:12px;height:350px;overflow-y:auto;padding:15px;background:#f9f9f9;margin-bottom:15px"></div>
<input id="input" placeholder="Try: erru, molyco, friedrice, egwusi, bonda" style="width:68%;padding:12px;border-radius:8px;border:1px solid #ccc"/>
<button onclick="send()" style="padding:12px 20px;border-radius:8px;background:#25D366;color:white;border:none;cursor:pointer;margin-left:5px">Send</button>
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
app.listen(PORT, () => console.log(`✅ SMART v2 running on :${PORT}`));
startWhatsApp().catch(err => console.error("❌ Failed:", err));