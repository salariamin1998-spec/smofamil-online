const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const categories = ["اسم", "فامیل", "شهر", "کشور", "غذا", "حیوان", "اشیا", "شغل"];
const letters = [..."اآبپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی"];

function code() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function publicRoom(r) {
  return {
    code: r.code, host: r.host, status: r.status, letter: r.letter,
    endsAt: r.endsAt, categories,
    players: [...r.players.values()].map(p => ({id:p.id, name:p.name, score:p.score, submitted:p.submitted}))
  };
}
function sendRoom(r) { io.to(r.code).emit("room:update", publicRoom(r)); }
function cleanName(s) { return String(s || "").trim().slice(0, 18) || "بازیکن"; }

io.on("connection", socket => {
  socket.on("room:create", ({name}, cb) => {
    let c; do { c = code(); } while (rooms.has(c));
    const r = {code:c, host:socket.id, status:"waiting", letter:"", endsAt:0, players:new Map(), timer:null};
    r.players.set(socket.id, {id:socket.id, name:cleanName(name), score:0, submitted:false, answers:{}});
    rooms.set(c, r); socket.join(c); cb?.({ok:true, code:c, room:publicRoom(r)});
    sendRoom(r);
  });

  socket.on("room:join", ({code:c, name}, cb) => {
    c = String(c || "").trim().toUpperCase();
    const r = rooms.get(c);
    if (!r) return cb?.({ok:false, error:"اتاق پیدا نشد. کد را بررسی کن."});
    if (r.status === "playing") return cb?.({ok:false, error:"بازی شروع شده؛ برای دور بعدی صبر کن."});
    if (r.players.size >= 10) return cb?.({ok:false, error:"ظرفیت اتاق (۱۰ نفر) تکمیل است."});
    r.players.set(socket.id, {id:socket.id, name:cleanName(name), score:0, submitted:false, answers:{}});
    socket.join(c); cb?.({ok:true, code:c, room:publicRoom(r)}); sendRoom(r);
  });

  socket.on("game:start", ({code:c, seconds}, cb) => {
    const r = rooms.get(String(c || "").toUpperCase());
    if (!r || r.host !== socket.id) return cb?.({ok:false, error:"فقط میزبان می‌تواند بازی را شروع کند."});
    if (r.players.size < 2) return cb?.({ok:false, error:"برای شروع حداقل دو بازیکن لازم است."});
    if (r.timer) clearTimeout(r.timer);
    r.status = "playing"; r.letter = letters[Math.floor(Math.random()*letters.length)];
    r.endsAt = Date.now() + Math.max(30, Math.min(120, Number(seconds)||60))*1000;
    for (const p of r.players.values()) { p.submitted = false; p.answers = {}; }
    io.to(r.code).emit("game:started", {letter:r.letter, endsAt:r.endsAt, categories});
    sendRoom(r);
    r.timer = setTimeout(() => finish(r), Math.max(0, r.endsAt-Date.now()));
    cb?.({ok:true});
  });

  socket.on("game:submit", ({code:c, answers}, cb) => {
    const r = rooms.get(String(c || "").toUpperCase());
    if (!r || r.status !== "playing") return cb?.({ok:false, error:"در حال حاضر بازی فعال نیست."});
    if (Date.now() > r.endsAt) { finish(r); return cb?.({ok:false, error:"زمان تمام شده است."}); }
    const p = r.players.get(socket.id);
    if (!p) return cb?.({ok:false, error:"بازیکن در اتاق نیست."});
    if (p.submitted) return cb?.({ok:false, error:"پاسخ تو قبلاً ثبت شده است."});
    p.answers = {};
    for (const cat of categories) p.answers[cat] = String((answers||{})[cat]||"").trim().slice(0,40);
    p.submitted = true;
    const all = [...r.players.values()].every(x => x.submitted);
    if (all) finish(r);
    cb?.({ok:true}); sendRoom(r);
  });

  socket.on("chat:send", ({code:c, message}) => {
    const r = rooms.get(String(c || "").toUpperCase());
    const p = r?.players.get(socket.id);
    const msg = String(message||"").trim().slice(0,180);
    if (r && p && msg) io.to(r.code).emit("chat:new", {name:p.name, message:msg});
  });

  socket.on("disconnect", () => {
    for (const r of rooms.values()) {
      if (r.players.has(socket.id)) {
        r.players.delete(socket.id);
        if (r.host === socket.id) r.host = r.players.keys().next().value || null;
        if (!r.players.size) { clearTimeout(r.timer); rooms.delete(r.code); }
        else { sendRoom(r); if (r.status === "playing" && [...r.players.values()].every(p=>p.submitted)) finish(r); }
      }
    }
  });
});

function normalize(s) {
  return String(s||"").replace(/[يى]/g,"ی").replace(/ك/g,"ک").replace(/[\u200c\s]/g,"").toLowerCase();
}
function finish(r) {
  if (!r || r.status !== "playing") return;
  clearTimeout(r.timer); r.status = "results";
  const submitted = [...r.players.values()];
  const results = submitted.map(p => {
    let points = 0;
    for (const cat of categories) {
      const a = normalize(p.answers[cat]);
      if (a && a.startsWith(normalize(r.letter))) {
        const duplicates = submitted.filter(q => q.id !== p.id && normalize(q.answers[cat]) === a).length;
        points += duplicates ? 5 : 10;
      }
    }
    p.score += points;
    return {id:p.id, name:p.name, answers:p.answers, points, total:p.score};
  }).sort((a,b)=>b.total-a.total);
  io.to(r.code).emit("game:results", {letter:r.letter, results});
  sendRoom(r);
}

server.listen(PORT, () => console.log(`Esm-o-Famil server running on ${PORT}`));