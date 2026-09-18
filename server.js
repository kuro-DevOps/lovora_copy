// ========================= Lovora backend =========================
// Statik fayllarni tarqatadi + WebSocket orqali juftliklarni real-time ulaydi.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 4211;
const ROOT = __dirname;
// Railway Volume uchun: DATA_DIR env berilsa, ma'lumot o'sha yerda saqlanadi (deploy'da o'chmaydi)
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Login (parol serverda, kodda ochiq emas) ----------
// Railway'da Variables orqali o'zgartiring: AUTH_USER, AUTH_PASS
const AUTH = {
  user: process.env.AUTH_USER || "osiyo",
  pass: process.env.AUTH_PASS || "lovora2026",
};
// Ikkalangiz uchun yagona (avtomatik) xona
const COUPLE_ROOM = process.env.COUPLE_ROOM || "LOVORA1";

// ---------- Statik server ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // xavfsizlik: papkadan chiqib ketishni oldini olish
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("403"); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Topilmadi"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
});

// ---------- Room (juftlik) holati ----------
const rooms = new Map(); // coupleId -> { state, clients:Set<ws> }

const emptyState = () => ({
  profile: { me: "", partner: "", date: "" },
  candleLit: false,
  answers: [],
  notes: [],
  memories: [],
  ttt: { board: Array(9).fill(""), turn: "❌", p1: 0, p2: 0, over: false, winLine: null },
});

function roomFile(id) { return path.join(DATA_DIR, id + ".json"); }

function loadRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  let state = null;
  try {
    if (fs.existsSync(roomFile(id))) state = JSON.parse(fs.readFileSync(roomFile(id), "utf8"));
  } catch (e) {}
  if (!state) return null;
  const room = { state, clients: new Set() };
  rooms.set(id, room);
  return room;
}

function persist(id) {
  const room = rooms.get(id);
  if (!room) return;
  try { fs.writeFileSync(roomFile(id), JSON.stringify(room.state)); } catch (e) {}
}

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // chalkash belgilar yo'q
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join("");
  } while (rooms.has(code) || fs.existsSync(roomFile(code)));
  return code;
}

// ---------- Reducer: harakatni holatga qo'llash ----------
const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function tttWinner(b) {
  for (const line of WINS) {
    const [a, c, d] = line;
    if (b[a] && b[a] === b[c] && b[a] === b[d]) return { mark: b[a], line };
  }
  return null;
}

function applyAction(state, action, p) {
  switch (action) {
    case "PROFILE_SET":
      state.profile = { me: p.me, partner: p.partner, date: p.date };
      break;
    case "CANDLE":
      state.candleLit = !!p.lit;
      break;
    case "ANSWER_ADD":
      state.answers.unshift(p);
      break;
    case "NOTE_ADD":
      state.notes.unshift(p);
      break;
    case "NOTE_DEL":
      state.notes = state.notes.filter((n) => n.id !== p.id);
      break;
    case "MEM_ADD":
      state.memories.unshift(p);
      break;
    case "MEM_DEL":
      state.memories = state.memories.filter((m) => m.id !== p.id);
      break;
    case "TTT_MOVE": {
      const t = state.ttt;
      if (t.over || t.board[p.i]) break;
      t.board[p.i] = t.turn;
      const w = tttWinner(t.board);
      if (w) {
        t.over = true; t.winLine = w.line;
        if (w.mark === "❌") t.p1++; else t.p2++;
      } else if (t.board.every((c) => c)) {
        t.over = true; t.winLine = null;
      } else {
        t.turn = t.turn === "❌" ? "⭕" : "❌";
      }
      break;
    }
    case "TTT_RESET": {
      const t = state.ttt;
      t.board = Array(9).fill(""); t.turn = "❌"; t.over = false; t.winLine = null;
      break;
    }
  }
  return state;
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

function broadcastPresence(id) {
  const room = rooms.get(id);
  if (!room) return;
  const msg = JSON.stringify({ type: "presence", count: room.clients.size });
  for (const c of room.clients) safeSend(c, msg);
}
function safeSend(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(msg);
}

wss.on("connection", (ws) => {
  ws.coupleId = null;

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    // --- Juftlik yaratish ---
    if (m.type === "create") {
      const id = genCode();
      const state = { ...emptyState(), ...(m.snapshot || {}) };
      // ttt strukturasi to'liq bo'lsin
      if (!state.ttt || !Array.isArray(state.ttt.board)) state.ttt = emptyState().ttt;
      const room = { state, clients: new Set([ws]) };
      rooms.set(id, room);
      ws.coupleId = id;
      persist(id);
      safeSend(ws, JSON.stringify({ type: "created", coupleId: id, state }));
      broadcastPresence(id);
      return;
    }

    // --- Juftlikka ulanish ---
    if (m.type === "join") {
      const id = String(m.coupleId || "").toUpperCase();
      const room = loadRoom(id);
      if (!room) { safeSend(ws, JSON.stringify({ type: "error", error: "not_found" })); return; }
      room.clients.add(ws);
      ws.coupleId = id;
      safeSend(ws, JSON.stringify({ type: "state", coupleId: id, state: room.state }));
      broadcastPresence(id);
      return;
    }

    // --- Login: parolni tekshiradi va avtomatik xonaga ulaydi ---
    if (m.type === "login") {
      const okUser = String(m.username || "").trim().toLowerCase() === AUTH.user.toLowerCase();
      const okPass = String(m.password || "") === AUTH.pass;
      if (!okUser || !okPass) {
        safeSend(ws, JSON.stringify({ type: "error", error: "badauth" }));
        return;
      }
      const id = COUPLE_ROOM;
      let room = loadRoom(id);
      if (!room) { room = { state: emptyState(), clients: new Set() }; rooms.set(id, room); persist(id); }
      room.clients.add(ws);
      ws.coupleId = id;
      safeSend(ws, JSON.stringify({ type: "authok", coupleId: id, state: room.state }));
      broadcastPresence(id);
      return;
    }

    // --- Harakat (o'zgarish) ---
    if (m.type === "action" && ws.coupleId) {
      const room = rooms.get(ws.coupleId);
      if (!room) return;
      applyAction(room.state, m.action, m.payload);
      persist(ws.coupleId);
      // boshqa qurilmalarga delta yuboramiz (aktyorning o'ziga emas)
      const delta = JSON.stringify({ type: "delta", action: m.action, payload: m.payload });
      for (const c of room.clients) if (c !== ws) safeSend(c, delta);
      return;
    }
  });

  ws.on("close", () => {
    if (ws.coupleId && rooms.has(ws.coupleId)) {
      const room = rooms.get(ws.coupleId);
      room.clients.delete(ws);
      broadcastPresence(ws.coupleId);
      // hech kim qolmasa xotiradan tushiramiz (diskda saqlangan)
      if (room.clients.size === 0) rooms.delete(ws.coupleId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Lovora ishga tushdi → http://localhost:${PORT}`);
});
