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

// ===== UTILS =====
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
  { id:"1", name:"Eru & Water Fufu/Garri", short:"Eru", price:1000, needsSide:true, main:"eru", keys:["eru","eruh","ero","erru","erue"] },
  { id:"2", name:"Egusi Soup & Water Fufu/Garri", short:"Egusi Soup", price:1000, needsSide:true, main:"egusi", keys:["egusi","egwusi","esgusi","egussi","egousi","egsui","egwsi","egusi soup"] },
  { id:"3", name:"Rice & Beans", short:"Rice & Beans", price:1000, needsSide:false, main:"beans", keys:["beans","bean","rice beans","rice & beans","rice and beans","white beans","haricot","riz haricot"] },
  { id:"4", name:"Fried Rice", short:"Fried Rice", price:1000, needsSide:false, main:"fried rice", keys:["fried rice","friedrice","fry rice","fried","chicken","jollof"] },
  { id:"5", name:"Turning Coco", short:"Turning Coco", price:1000, needsSide:false, main:"coco", keys:["coco","cocoa","turning","turning coco","turning cocoa","kati","turing"] },
];

const LOCATION_DB = [
  { name:"Bonduma around 100m", fee:500, keys:["bonduma","around bonduma","near field","bonduma field","bonduma 100m","near bonduma","bonduma around"] },
  { name:"Bonduma beyond 100m", fee:1000, keys:["bonduma beyond","far bonduma","beyond bonduma","bonduma far","far from bonduma","bonduma street far"] },
  { name:"Molyko", fee:1000, keys:["molyko","molyco","moleko","moly","malyko"] },
  { name:"Malingo", fee:1000, keys:["malingo","maligo"] },
  { name:"Muea", fee:1000, keys:["muea"] },
  { name:"Checkpoint", fee:1000, keys:["checkpoint","check point"] },
  { name:"Buea Town", fee:1000, keys:["buea town","buea","town","bueatown"] },
  { name:"Soppo", fee:1000, keys:["soppo","great soppo","small soppo"] },
];

function findBestDish(text) {
  const lower = text.toLowerCase();
  for(let dish of MENU_DB){
    for(let k of dish.keys){
      if(lower.includes(k)) return dish;
    }
    if(lower.includes(dish.main)) return dish;
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

function findSide(text){
  const lower = text.toLowerCase();
  if(/garr?i|garry|gary/.test(lower)) return "Garri";
  if(/water\s*fufu|waterfufu|water\s*foofoo/.test(lower)) return "Water Fufu";
  if(/\bfufu\b|\bfoofoo\b/.test(lower)) return "Water Fufu";
  return null;
}

function findLocation(text){
  const lower = text.toLowerCase();
  if(lower.includes("beyond") || lower.includes("far")){
    if(lower.includes("bonduma")) return LOCATION_DB[1];
  }
  for(let loc of LOCATION_DB){
    for(let k of loc.keys){
      if(lower.includes(k)) return loc;
    }
  }
  if(lower.includes("bonduma")) return LOCATION_DB[0];
  return null;
}

function parseOrders(fullText){
  const lower = fullText.toLowerCase();
  const parts = lower.split(/\s*(?:and|&|\+|,|with|plus)\s*/);
  // Actually we need smarter: keep "with garri" with dish
  // Re-parse by dishes
  let orders = [];
  // Strategy: find all dish mentions with qty around them
  const raw = lower;

  // Split by +, and
  const chunks = raw.split(/\s*\+\s*|\s+and\s+|\s*,\s*/);

  for(let chunk of chunks){
    if(!chunk.trim()) continue;
    let qty = 1;
    const numMatch = chunk.match(/(\d+)\s*(?:plates?|pla)?/i);
    if(numMatch) qty = parseInt(numMatch[1]);
    else {
      const startNum = chunk.trim().match(/^(\d+)\b/);
      if(startNum) qty = parseInt(startNum[1]);
    }
    if(qty<1) qty=1; if(qty>5) qty=5; // per item cap 5

    const dish = findBestDish(chunk);
    if(dish){
      const side = dish.needsSide? findSide(chunk) : null;
      // Try to find side in next chunk if pattern "eru with garri" was split by "with"
      // So we also check full text for side near dish name
      orders.push({ dish, qty, side, raw: chunk.trim() });
    }
  }

  // Fallback: if parsing by chunks failed, try to extract multiple dishes from whole sentence
  if(orders.length===0){
    const dish = findBestDish(lower);
    if(dish){
      const numAnywhere = lower.match(/(\d+)/);
      let qty = numAnywhere? parseInt(numAnywhere[1]) : 1;
      if(qty<1) qty=1; if(qty>5) qty=5;
      const side = findSide(lower);
      orders.push({ dish, qty, side, raw: lower });
    }
  }

  // Fix side for "with" split: if chunk was "eru" and next word is "garri", merge
  // Simple fix: look ahead in original text
  for(let i=0;i<orders.length;i++){
    if(orders[i].dish.needsSide &&!orders[i].side){
      // Search around the dish name in full text for garri/water fufu
      const dishIndex = lower.indexOf(orders[i].dish.main);
      if(dishIndex!==-1){
        const windowText = lower.substring(dishIndex, dishIndex+30);
        const sideInWindow = findSide(windowText);
        if(sideInWindow) orders[i].side = sideInWindow;
      }
    }
  }

  return orders;
}

function getBotReply(text) {
  const lower = (text||"").toLowerCase().trim();
  if(!lower) return null;

  // MENU / HELP
  if(["menu","catalog","catelog","list","dishes","show menu","food","chop","plate"].some(k=>lower.includes(k))){
    return "__SEND_MENU_IMAGE__";
  }
  if(["help","commands","how to order","order"].some(k=>lower.includes(k)) && lower.length<15){
    return `📋 *HOW TO ORDER - Max 5 plates*\n\n🍽 *Menu - All 1000F*\n1️⃣ Eru & Water Fufu/Garri (choose side)\n2️⃣ Egusi & Water Fufu/Garri (choose side)\n3️⃣ Rice & Beans\n4️⃣ Fried Rice\n5️⃣ Turning Coco\n\n👉 *Commands:*\n"eru with garri"\n"egusi with water fufu"\n"2 plates eru with garri"\n"2plates eru with water fufu"\n"2 eru with garri + 1 fried rice + 1 beans"\n"2 eru with garri molyko"\n\n🛵 *Delivery:*\n• Bonduma around 100m = 500F\n• Beyond Bonduma = 1000F\n• Molyko/Malingo/Muea/Buea Town/Soppo/Checkpoint = 1000F\n\nMax 5 plates per order.\nType "menu" for picture 📸`;
  }

  const orders = parseOrders(lower);
  const loc = findLocation(lower);

  // Handle orders
  if(orders.length>0){
    // Check total plates limit = 5
    const totalPlates = orders.reduce((s,o)=>s+o.qty,0);
    if(totalPlates>5){
      return `⚠️ *Max 5 plates per order!* 🍲\n\nYou ordered ${totalPlates} plates: "${text}"\n\nWe have 5 different dishes max.\nPlease reduce to 5 plates total.\n\nExample:\n"2 eru with garri + 2 egusi with water fufu + 1 fried rice = 5 plates" ✅\n"6 plates eru" ❌ (max 5)\n\nType "menu" for list.`;
    }

    // Check if Eru/Egusi missing side
    const missingSide = orders.filter(o=>o.dish.needsSide &&!o.side);
    if(missingSide.length>0){
      const dishNames = missingSide.map(o=>o.dish.short).join(" & ");
      return `✅ *${dishNames} chosen!* 🍲\n\n⚠️ You must choose side for ${dishNames}:\n👉 *Water Fufu* OR *Garri*\n\nReply like:\n"${missingSide[0].dish.main} with garri"\n"${missingSide[0].dish.main} with water fufu"\n"2 plates ${missingSide[0].dish.main} with garri"\n\nFor 5 plates max example:\n"2 eru with garri + 2 egusi with water fufu + 1 fried rice"\n\n🛵 Delivery: Bonduma around 100m=500F, Beyond=1000F`;
    }

    // Calculate totals
    let totalFood = 0;
    let summary = "";
    for(let o of orders){
      const sub = o.qty * o.dish.price;
      totalFood += sub;
      const sideText = o.side? ` with ${o.side}` : "";
      summary += `• ${o.qty}x ${o.dish.short}${sideText} = ${sub}F\n`;
    }
    const deliveryFee = loc? loc.fee : 500;
    const grandTotal = totalFood + deliveryFee;

    if(orders.length===1){
      const o = orders[0];
      const fullName = `${o.dish.short}${o.side? ` with ${o.side}`:""}`;
      return `✅ *ORDER CONFIRMED - ${totalPlates}/5 plates* 🍲\n\n"${text}"\n→ *${fullName}* ✅\n\n${summary}📍 ${loc? `${loc.name} = ${deliveryFee}F` : `Delivery: Bonduma around 100m=500F, Beyond=1000F (send quarter)`}\n━━━━━━━━━━━━\n💵 *TOTAL: ${grandTotal}F*\n\nType *YES + your quarter + phone* to finalize\nExample: "YES Molyko 674496557"`;
    }

    return `✅ *ORDER CONFIRMED - ${totalPlates}/5 plates* 🍲\n\n"${text}"\n\n${summary}🍚 Food: ${totalFood}F (${totalPlates} plates)\n📍 ${loc? `${loc.name} = ${deliveryFee}F` : `Delivery: 500F around Bonduma, 1000F beyond`}\n━━━━━━━━━━━━\n💵 *GRAND TOTAL: ${grandTotal}F*\n\nType *YES + quarter + phone* to finalize\nExample: "YES Molyko 674496557"\n\nMax 5 plates per order.`;
  }

  if(loc){
    return `📍 *Delivery Updated* ✅\n\n${loc.name} = *${loc.fee}F*\n\nOther fees:\n• Bonduma around 100m = 500F\n• Bonduma beyond = 1000F\n• All other quarters = 1000F\n\nNow order: "eru with garri" or "menu"`;
  }

  if(["pay","paid","momo","don pay","sent","i don pay"].some(k=>lower.includes(k))){
    return `✅ *Payment - Consty's Kitchen* 💰\n\n📱 MoMo: 674496557\nName: Constance\n\nAfter payment type amount:\nExample: "I don pay 2500F"\n\nThank you! 🙏`;
  }

  if(["bill","facture","total","how much"].some(k=>lower.includes(k))){
    return `🧾 *To get bill, send order like:*\n"2 plates eru with garri molyko"\n"1 eru with garri + 1 egusi with water fufu + 1 fried rice"\n\nI will calculate automatically with delivery.\nMax 5 plates.`;
  }

  if(["garri","water fufu","fufu"].some(k=>lower.includes(k)) && lower.split(" ").length<=4){
    return `👋 You need to tell dish too:\n"eru with garri" ✅\n"egusi with water fufu" ✅\n\nNot just "garri" ❌\n\nType "menu" for list`;
  }

  if(["yes","confirm","yeah","ok"].some(k=>lower===k || lower.startsWith(k+" "))){
    return `✅ *Confirmed!* 🎉\n\nPlease send:\n1. Your full quarter (Bonduma around/beyond, Molyko etc)\n2. Phone number\n3. Exact location description\n\nExample: "YES Molyko 674496557 behind UB"\n\nWe will deliver soon! 🛵`;
  }

  return `👋 *Welcome to Consty's Kitchen!* 🍽\n\n*Specialty - Max 5 plates - All 1000F*\n1️⃣ Eru (choose Garri or Water Fufu)\n2️⃣ Egusi (choose Garri or Water Fufu)\n3️⃣ Rice & Beans\n4️⃣ Fried Rice\n5️⃣ Turning Coco\n\n*How to order:*\n"eru with garri"\n"2 plates egusi with water fufu"\n"2 eru with garri + 1 fried rice + 2 beans = 5 plates"\n\n🛵 Delivery: Around Bonduma 100m=500F, Beyond=1000F, Others=1000F\n\nType "menu" for picture 📸\n"help" for commands\n📱 674496557`;
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
            caption: `🍽 *OUR SPECIALTY MENU - Max 5 Plates - All 1000F* 🍲\n\n1️⃣ Eru & Water Fufu/Garri (Choose side)\n2️⃣ Egusi Soup & Water Fufu/Garri (Choose side)\n3️⃣ Rice & Beans - 1000F\n4️⃣ Turning Coco - 1000F\n5️⃣ Fried Rice - 1000F\n\n👉 *How to order:*\n"eru with garri"\n"egusi with water fufu"\n"2 plates eru with garri"\n"2 eru with garri + 1 fried rice + 2 beans = 5 plates max"\n\n🛵 *Delivery:*\n• Bonduma around 100m = 500F\n• Beyond Bonduma = 1000F\n• Molyko, Malingo, Muea, Buea Town, Soppo = 1000F\n\n📱 MoMo: 674496557\n⏰ Mon-Sat 10AM-6PM`
          });
        } else {
          await sock.sendMessage(from, { text: `🍽 *OUR SPECIALTY MENU - Max 5 plates*\n\n1️⃣ Eru & Garri/Water Fufu - 1000F\n2️⃣ Egusi & Garri/Water Fufu - 1000F\n3️⃣ Rice & Beans - 1000F\n4️⃣ Turning Coco - 1000F\n5️⃣ Fried Rice - 1000F\n\nOrder: "eru with garri" etc\nDelivery: around 500F beyond 1000F` });
        }
      } catch (e) { await sock.sendMessage(from, { text: `Menu error ${e.message}` }); }
      return;
    }
    await sock.sendMessage(from, { text: reply });
  });
}

app.get("/", (_req,res)=>res.type("html").send(`<html><body style="font-family:system-ui;padding:20px"><h1>🤖 Consty's FINAL v7 - Max 5 Plates Complete ✅</h1><p>Status: <b>${connectionStatus}</b></p><p><a href="/qr">QR</a> | <a href="/test">Test</a></p><p>Features: Garri/Water Fufu + Delivery 500/1000 + Max 5 plates + All commands</p><img src="/menu-image" style="max-width:400px;border-radius:12px;" /></body></html>`));
app.get("/menu-image", (_req,res)=>{
  const a = path.join(process.cwd(),"menu.jpg"); const b = path.join(process.cwd(),"Catalog_Menu.jpg");
  if(fs.existsSync(a)) res.sendFile(a); else if(fs.existsSync(b)) res.sendFile(b); else res.status(404).send("No image");
});
app.get("/qr", (_req,res)=>{
  const img = lastQRDataURL? `<img src="${lastQRDataURL}" style="max-width:360px;border-radius:12px;" />` : `<p>Already connected ✅</p>`;
  res.type("html").send(`<html><head><meta http-equiv="refresh" content="5"></head><body style="font-family:system-ui;display:grid;place-items:center;height:100vh"><h2>Scan: 674496557</h2>${img}<br/><a href="/">Back</a></body></html>`);
});
app.get("/test", (_req,res)=>res.type("html").send(`<html><body style="max-width:600px;margin:20px auto;font-family:system-ui"><h2>Test FINAL v7 - Max 5 Plates</h2><div id="chat" style="border:1px solid #ccc;height:380px;overflow:auto;padding:10px;background:#f9f9f9"></div><input id="i" placeholder="Try: 2 eru with garri + 2 egusi with water fufu + 1 fried rice" style="width:70%;padding:12px"/><button onclick="send()" style="padding:12px;background:#25D366;color:white;border:none">Send</button><br/><br/><img src="/menu-image" style="max-width:100%;border-radius:12px"/><script>const c=document.getElementById('chat');const inp=document.getElementById('i');async function send(){const t=inp.value;if(!t)return;c.innerHTML+='<div style="text-align:right;margin:6px"><span style="background:#DCF8C6;padding:8px 12px;border-radius:12px;display:inline-block">'+t+'</span></div>';inp.value='';const r=await fetch('/test-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})});const d=await r.json();const rep=d.reply==='__SEND_MENU_IMAGE__'?'[MENU IMAGE]':d.reply;c.innerHTML+='<div style="text-align:left;margin:6px"><span style="background:white;padding:8px 12px;border-radius:12px;display:inline-block;white-space:pre-wrap;border:1px solid #eee">'+rep+'</span></div>';c.scrollTop=c.scrollHeight}inp.addEventListener('keypress',e=>{if(e.key==='Enter')send()});</script></body></html>`));
app.post("/test-message", (req,res)=>{ res.json({ reply: getBotReply(req.body.text||"") }); });
app.listen(PORT, ()=>console.log(`✅ FINAL v7 Max 5 Plates Complete on :${PORT}`));
startWhatsApp();