import express from "express";
import cors from "cors";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || "./sessions/default";
const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let lastQRDataURL = null;
let connectionStatus = "disconnected";

// ===== TYPO FIXER =====
function levenshtein(a, b) {
  const m = Array(b.length+1).fill(null).map(()=>Array(a.length+1).fill(null));
  for(let i=0;i<=a.length;i++) m[0][i]=i;
  for(let j=0;j<=b.length;j++) m[j][0]=j;
  for(let j=1;j<=b.length;j++){
    for(let i=1;i<=a.length;i++){
      const cost = a[i-1]===b[j-1]?0:1;
      m[j][i]=Math.min(m[j][i-1]+1, m[j-1][i]+1, m[j-1][i-1]+cost);
    }
  }
  return m[b.length][a.length];
}

const MENU_DB = [
  { id:"1", name:"Eru & Water Fufu/Garri", price:1000, main:"eru", keys:["eru","eruh","ero","erru","erue","water fufu","waterfufu","fufu eru"] },
  { id:"2", name:"Egusi Soup & Water Fufu/Garri", price:1000, main:"egusi", keys:["egusi","egwusi","esgusi","egussi","egousi","egsui","egwsi","egusi soup"] },
  { id:"3", name:"Rice & Beans", price:1000, main:"beans", keys:["beans","bean","rice beans","rice & beans","rice and beans","white beans","haricot"] },
  { id:"4", name:"Fried Rice", price:1000, main:"fried rice", keys:["fried rice","friedrice","fry rice","fried","chicken","jollof","fried rice chicken"] },
  { id:"5", name:"Turning Coco", price:1000, main:"coco", keys:["coco","cocoa","turning","turning coco","turning cocoa","kati","turing","turn coco"] },
];

const LOCATION_DB = [
  { name:"bonduma", fee:300, keys:["bonduma","bonda","bondma","bondouma"] },
  { name:"molyko", fee:500, keys:["molyko","molyco","moleko","moly","malyko"] },
  { name:"malingo", fee:500, keys:["malingo","maligo"] },
  { name:"muea", fee:500, keys:["muea"] },
  { name:"checkpoint", fee:500, keys:["checkpoint","check point"] },
  { name:"buea town", fee:700, keys:["buea town","buea","town","bueatown"] },
  { name:"soppo", fee:700, keys:["soppo","great soppo","small soppo"] },
];

function findBestDish(text) {
  const lower = text.toLowerCase();
  for(let dish of MENU_DB){
    for(let k of dish.keys){
      if(lower.includes(k)) return dish;
    }
  }
  const words = lower.split(/[^a-z0-9]+/).filter(w=>w.length>=2);
  for(let word of words){
    for(let dish of MENU_DB){
      for(let k of dish.keys){
        const cleanKey = k.replace(/[^a-z]/g,"");
        if(cleanKey.length<3) continue;
        if(levenshtein(word, cleanKey) <=1) return dish;
        if(cleanKey.length>=5 && levenshtein(word, cleanKey) <=2) return dish;
      }
      if(levenshtein(word, dish.main) <=1) return dish;
    }
  }
  return null;
}

function findLocation(text){
  const lower = text.toLowerCase();
  for(let loc of LOCATION_DB){
    for(let k of loc.keys){
      if(lower.includes(k)) return loc;
    }
  }
  return null;
}

function parseOrders(fullText){
  const lower = fullText.toLowerCase();
  const parts = lower.split(/\s+(?:and|&|\+|,)\s+/);
  const orders = [];

  for(let part of parts){
    if(!part.trim()) continue;
    let qty = 1;
    const qtyMatch1 = part.match(/(\d+)\s*(?:plates?|pla|plt)?/i);
    const qtyMatch2 = part.match(/(?:plates?|pla)\s*(\d+)/i);
    if(qtyMatch1 && qtyMatch1[1]){
      qty = parseInt(qtyMatch1[1]);
    } else if(qtyMatch2 && qtyMatch2[1]){
      qty = parseInt(qtyMatch2[1]);
    } else {
      const startNum = part.trim().match(/^(\d+)\s+/);
      if(startNum) qty = parseInt(startNum[1]);
    }
    if(qty <1) qty=1;
    if(qty >20) qty=20;
    const dish = findBestDish(part);
    if(dish){
      orders.push({ dish, qty, raw: part.trim() });
    }
  }

  if(orders.length===0){
    const dish = findBestDish(lower);
    if(dish){
      const numAnywhere = lower.match(/(\d+)/);
      let qty = numAnywhere? parseInt(numAnywhere[1]) : 1;
      if(qty<1) qty=1;
      if(qty>20) qty=20;
      orders.push({ dish, qty, raw: lower });
    }
  }
  return orders;
}

function getBotReply(text) {
  const lower = (text||"").toLowerCase().trim();
  if(!lower) return null;

  if(["menu","catalog","catelog","list","food list","dishes","show menu","commands","help"].some(k=>lower.includes(k))){
    return "__SEND_MENU_IMAGE__";
  }

  const orders = parseOrders(lower);
  const loc = findLocation(lower);

  if(orders.length>0){
    let totalFood = 0;
    let summary = "";
    for(let o of orders){
      const sub = o.qty * o.dish.price;
      totalFood += sub;
      summary += `• ${o.qty}x ${o.dish.name} = ${sub}F\n`;
    }
    const deliveryFee = loc? loc.fee : 500;
    const grandTotal = totalFood + deliveryFee;
    const totalPlates = orders.reduce((s,o)=>s+o.qty,0);

    if(orders.length===1){
      const o = orders[0];
      return `✅ *Order Received!* 🍲\n\nYou said: "${text}"\n→ *${o.dish.name}* ✅ - 1000F per plate\n\n🔢 Qty: ${o.qty} plate(s) x 1000F = ${o.qty*1000}F\n${loc? `📍 Delivery to ${loc.name}: ${deliveryFee}F` : `🛵 Delivery: ~${deliveryFee}F (send quarter e.g. Molyko)`}\n━━━━━━━━━━━━\n💵 *TOTAL: ${grandTotal}F for ${totalPlates} plate(s)*\n\nConfirm?\nSend your quarter + phone.\nType *YES* to confirm ${o.dish.name}`;
    }

    return `✅ *Order Received!* 🍲\n\nYou said: "${text}"\n\n${summary}🍚 Total Food: ${totalFood}F (${totalPlates} plates)\n${loc? `📍 Delivery to ${loc.name}: ${deliveryFee}F` : `🛵 Delivery: ~${deliveryFee}F`}\n━━━━━━━━━━━━\n💵 *GRAND TOTAL: ${grandTotal}F*\n\nConfirm?\nSend your quarter + phone.\nType *YES* to confirm`;
  }

  if(loc && lower.split(" ").length<=4){
    return `📍 You mean *${loc.name.toUpperCase()}* right? ✅\n🛵 Delivery fee: *${loc.fee}F*\nNow tell us what you want to eat. Type "menu" 📸`;
  }

  if(["pay","paid","momo","don pay","sent"].some(k=>lower.includes(k))){
    return `✅ *Payment Received!* 💰\nMoMo: 674496557\nThank you! Order preparing 😊`;
  }

  if(lower.length>=2 && lower.length<=12){
    return `👋 Did you mean:\n1️⃣ Eru\n2️⃣ Egusi\n3️⃣ Rice & Beans\n4️⃣ Fried Rice\n5️⃣ Turning Coco\n\nExamples:\n"2 plates eru"\n"3 eru molyko"\n"2 eru + 1 fried rice"\n\nType "menu" for pictures 📸`;
  }

  return `👋 Welcome to Consty's Kitchen! 🍽\nAll dishes *1,000F*\n\nType "menu" for catalog with pictures 📸\nOr just type what you want:\n"eru" "egusi" "beans" "fried rice" "coco"\nI understand typos like erru, esgusi, friedrice 😊\n\n📱 674496557`;
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: ["Chrome", "Linux", "128.0"] });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) lastQRDataURL = await qrcode.toDataURL(qr);
    if (connection === "open") { connectionStatus = "connected"; lastQRDataURL=null; console.log("✅ Connected"); }
    else if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut;
      connectionStatus = "disconnected";
      if (shouldReconnect) setTimeout(startWhatsApp, 2000);
    }
  });
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe) return;
    const from = msg.key.remoteJid;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
    if (!text) return;
    const reply = getBotReply(text);
    if (!reply) return;
    if (reply === "__SEND_MENU_IMAGE__") {
      try {
        const menuPath = path.join(process.cwd(), "menu.jpg");
        const altPath = path.join(process.cwd(), "Catalog_Menu.jpg");
        let p = fs.existsSync(menuPath)? menuPath : (fs.existsSync(altPath)? altPath : null);
        if (p) {
          await sock.sendMessage(from, {
            image: fs.readFileSync(p),
            caption: `🍽 *OUR SPECIALTY MENU - Consty's Kitchen* 🍲\n\nAll dishes *1,000F* only!\n\n1️⃣ Eru & Water Fufu/Garri - 1000F\n2️⃣ Egusi Soup & Water Fufu/Garri - 1000F\n3️⃣ Rice & Beans - 1000F\n4️⃣ Turning Coco - 1000F\n5️⃣ Fried Rice - 1000F\n\n👉 Order examples:\n"2 plates eru"\n"3 eru molyko"\n"2 eru + 1 fried rice"\n\nI understand typos! erru, esgusi, friedrice, molyco ✅\n📍 Bonduma after Field 2nd left\n⏰ Mon-Sat 10AM-6PM\n📱 MoMo: 674496557`
          });
        } else {
          await sock.sendMessage(from, { text: `🍽 *OUR SPECIALTY MENU*\n\n1️⃣ Eru & Water Fufu - 1000F\n2️⃣ Egusi - 1000F\n3️⃣ Rice & Beans - 1000F\n4️⃣ Turning Coco - 1000F\n5️⃣ Fried Rice - 1000F\n\nType "2 plates eru" to order` });
        }
      } catch (e) { await sock.sendMessage(from, { text: `Menu error ${e.message}` }); }
      return;
    }
    await sock.sendMessage(from, { text: reply });
  });
}

app.get("/", (_req,res)=>res.type("html").send(`<html><body style="font-family:system-ui;padding:20px"><h1>🤖 Consty's v5.1 Quantity FIXED ✅</h1><p>Status: <b>${connectionStatus}</b></p><p><a href="/qr">📱 QR Code</a> | <a href="/test">💬 Test Bot</a></p><p>Try: 2plates eru, esgusi, 2 eru + 1 fried rice</p><br/><img src="/menu-image" style="max-width:400px;border-radius:12px;" /></body></html>`));
app.get("/menu-image", (_req,res)=>{
  const a = path.join(process.cwd(),"menu.jpg"); const b = path.join(process.cwd(),"Catalog_Menu.jpg");
  if(fs.existsSync(a)) res.sendFile(a); else if(fs.existsSync(b)) res.sendFile(b); else res.status(404).send("No image");
});
app.get("/qr", (_req,res)=>{
  const img = lastQRDataURL? `<img src="${lastQRDataURL}" style="max-width:360px;border-radius:12px;" />` : `<p>Already connected ✅</p>`;
  res.type("html").send(`<html><head><meta http-equiv="refresh" content="5"></head><body style="font-family:system-ui;display:grid;place-items:center;height:100vh"><h2>Scan: 674496557</h2>${img}<br/><a href="/">Back</a></body></html>`);
});
app.get("/test", (_req,res)=>res.type("html").send(`<html><body style="max-width:500px;margin:20px auto;font-family:system-ui"><h2>Test v5.1 - All Commands</h2><div id="chat" style="border:1px solid #ccc;height:350px;overflow:auto;padding:10px;background:#f9f9f9"></div><input id="i" placeholder="Try: 2plates eru, esgusi, 2 eru + 1 fried rice, menu" style="width:68%;padding:12px;border-radius:8px;border:1px solid #ccc"/><button onclick="send()" style="padding:12px;border-radius:8px;background:#25D366;color:white;border:none">Send</button><br/><br/><img src="/menu-image" style="max-width:100%;border-radius:12px"/><script>const c=document.getElementById('chat');const inp=document.getElementById('i');async function send(){const t=inp.value;if(!t)return;c.innerHTML+='<div style="text-align:right;margin:6px"><span style="background:#DCF8C6;padding:8px 12px;border-radius:12px;display:inline-block">'+t+'</span></div>';inp.value='';const r=await fetch('/test-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})});const d=await r.json();const rep=d.reply==='__SEND_MENU_IMAGE__'?'[MENU IMAGE + CATALOG]':d.reply;c.innerHTML+='<div style="text-align:left;margin:6px"><span style="background:white;padding:8px 12px;border-radius:12px;display:inline-block;white-space:pre-wrap;border:1px solid #eee">'+rep+'</span></div>';c.scrollTop=c.scrollHeight}inp.addEventListener('keypress',e=>{if(e.key==='Enter')send()});</script></body></html>`));
app.post("/test-message", (req,res)=>{ res.json({ reply: getBotReply(req.body.text||"") }); });
app.listen(PORT, ()=>console.log(`✅ v5.1 FINAL on :${PORT}`));
startWhatsApp();