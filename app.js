// ========================= Lovora — asosiy mantiq (login + real-time sync) =========================
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const KEY = "lovora_v1";
const AUTH_KEY = "lovora_auth";
const IAM_KEY = "lovora_iam";
const CFG = window.LOVORA_CONFIG || {};
let iam = localStorage.getItem(IAM_KEY) || "";
const currentPerson = () => iam || CFG.me || "Men";

// "Yangi" belgilar (yorimizdan kelgan, hali ko'rilmagan)
const unseen = { questions: false, notes: false, memories: false };

// ---- Ma'lumotlar modeli (server bilan bir xil) ----
const defaultData = () => ({
  profile: { me: "", partner: "", date: "" },
  candleLit: false,
  answers: [],
  notes: [],
  memories: [],
  ttt: { board: Array(9).fill(""), turn: "❌", p1: 0, p2: 0, over: false, winLine: null },
  dailySeed: null,
});

let data = load() || defaultData();
// Ismlar/sana config'dan (bir marta urug')
if (!data.profile.me) data.profile = { me: CFG.me || "", partner: CFG.partner || "", date: CFG.startDate || "" };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = { ...defaultData(), ...JSON.parse(raw) };
    if (!d.ttt || !Array.isArray(d.ttt.board)) d.ttt = defaultData().ttt;
    return d;
  } catch (e) { return null; }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {} }

// ---- Sana yordamchilari ----
const UZ_MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun",
  "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const fmtDate = (ts) => { const d = new Date(ts); return `${d.getDate()}-${UZ_MONTHS[d.getMonth()]}, ${d.getFullYear()}`; };
const todayKey = () => new Date().toISOString().slice(0, 10);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ========================= REDUCER =========================
const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function tttWinner(b) {
  for (const line of WINS) { const [a, c, d] = line; if (b[a] && b[a] === b[c] && b[a] === b[d]) return { mark: b[a], line }; }
  return null;
}
function reduce(action, p) {
  switch (action) {
    case "PROFILE_SET": data.profile = { me: p.me, partner: p.partner, date: p.date }; break;
    case "CANDLE": data.candleLit = !!p.lit; break;
    case "ANSWER_ADD": data.answers.unshift(p); break;
    case "NOTE_ADD": data.notes.unshift(p); break;
    case "NOTE_DEL": data.notes = data.notes.filter((n) => n.id !== p.id); break;
    case "MEM_ADD": data.memories.unshift(p); break;
    case "MEM_DEL": data.memories = data.memories.filter((m) => m.id !== p.id); break;
    case "TTT_MOVE": {
      const t = data.ttt;
      if (t.over || t.board[p.i]) break;
      t.board[p.i] = t.turn;
      const w = tttWinner(t.board);
      if (w) { t.over = true; t.winLine = w.line; if (w.mark === "❌") t.p1++; else t.p2++; }
      else if (t.board.every((c) => c)) { t.over = true; t.winLine = null; }
      else { t.turn = t.turn === "❌" ? "⭕" : "❌"; }
      break;
    }
    case "TTT_RESET": { const t = data.ttt; t.board = Array(9).fill(""); t.turn = "❌"; t.over = false; t.winLine = null; break; }
  }
}
function dispatch(action, payload) { reduce(action, payload); save(); sync.send(action, payload); renderFor(action); }
function applyRemote(action, payload) { reduce(action, payload); save(); renderFor(action); markUnseen(action); }

function renderFor(action) {
  if (action.startsWith("TTT")) return renderBoard();
  if (action === "CANDLE") return renderCandle();
  if (action === "ANSWER_ADD") return renderAnswers();
  if (action.startsWith("NOTE")) return renderNotes();
  if (action.startsWith("MEM")) return renderMemories();
  if (action === "PROFILE_SET") { renderProfile(); renderDays(); return; }
  renderAll();
}
function renderAll() {
  renderProfile(); renderDays(); renderCandle(); pickDaily();
  renderAnswers(); renderNotes(); renderMemories(); renderBoard();
}

// Yorimizdan yangi narsa kelsa, menyuda belgi
const SECTION_OF = { ANSWER_ADD: "questions", NOTE_ADD: "notes", MEM_ADD: "memories" };
function markUnseen(action) {
  const sec = SECTION_OF[action];
  if (!sec) return;
  if (currentView !== sec) { unseen[sec] = true; renderBadges(); }
}
function renderBadges() {
  ["questions", "notes", "memories"].forEach((sec) => {
    const b = document.querySelector(`.nav-btn[data-go="${sec}"] .nav-badge`);
    if (b) b.hidden = !unseen[sec];
  });
}

// ========================= SYNC (WebSocket + login) =========================
const sync = {
  ws: null,
  coupleId: null,
  bothOnline: false,
  creds: null, // {u,p}

  url() { return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`; },

  // Login: WS ochamiz, parolni yuboramiz
  connectAndLogin(u, p) {
    this.creds = { u, p };
    this._open(() => this._raw({ type: "login", username: u, password: p }));
  },

  logout() {
    localStorage.removeItem(AUTH_KEY);
    this.creds = null; this.coupleId = null;
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
  },

  _open(onReady) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return onReady();
    try { this.ws = new WebSocket(this.url()); } catch (e) { showLoginError("Serverga ulanib bo'lmadi"); return; }
    this.ws.onopen = () => onReady();
    this.ws.onmessage = (ev) => this._onMsg(ev);
    this.ws.onclose = () => { setConn(false, false); this.bothOnline = false; renderCandle(); renderConnUI(); if (this.creds) scheduleReconnect(); };
    this.ws.onerror = () => {};
  },
  _raw(o) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); },
  send(action, payload) { if (this.coupleId) this._raw({ type: "action", action, payload }); },

  _onMsg(ev) {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "authok") {
      this.coupleId = m.coupleId;
      if (m.me) { iam = m.me; localStorage.setItem(IAM_KEY, m.me); } // login kim ekanini aniqlaydi
      localStorage.setItem(AUTH_KEY, JSON.stringify(this.creds));
      // serverdagi umumiy kontent (candle/answers/notes/memories/ttt), ismlar config'dan qoladi
      const seed = data.dailySeed, prof = data.profile;
      data = { ...defaultData(), ...m.state, profile: prof, dailySeed: seed };
      if (!data.ttt || !Array.isArray(data.ttt.board)) data.ttt = defaultData().ttt;
      save();
      setConn(true, false);
      onAuthSuccess();
    } else if (m.type === "delta") {
      applyRemote(m.action, m.payload);
    } else if (m.type === "presence") {
      this.bothOnline = m.count >= 2;
      setConn(true, this.bothOnline);
      renderCandle(); renderConnUI();
    } else if (m.type === "error" && m.error === "badauth") {
      showLoginError("Login yoki parol noto'g'ri");
    }
  },
};
let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer || !sync.creds) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; sync.connectAndLogin(sync.creds.u, sync.creds.p); }, 3000);
}
function setConn(connected, both) {
  const dot = $("#conn-dot");
  dot.classList.toggle("waiting", connected && !both);
  dot.classList.toggle("both", connected && both);
  dot.title = !connected ? "Ulanmagan" : both ? "Ikkalangiz onlayn 💚" : "Ulangan — yor kutilmoqda";
}

// ========================= LOGIN sahifasi =========================
function showLogin() {
  $("#login").classList.remove("hidden");
  $("#app").classList.add("hidden");
}
function showLoginError(msg) {
  const e = $("#login-error");
  e.textContent = msg; e.classList.remove("hidden");
  const btn = $("#login-btn"); btn.disabled = false; btn.textContent = "Kirish 💕";
}
$("#login-btn").addEventListener("click", () => {
  const u = $("#login-user").value.trim();
  const p = $("#login-pass").value;
  if (!u || !p) { showLoginError("Login va parolni kiriting"); return; }
  $("#login-error").classList.add("hidden");
  const btn = $("#login-btn"); btn.disabled = true; btn.textContent = "Ulanmoqda...";
  sync.connectAndLogin(u, p);
});
$("#login-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#login-btn").click(); });

function onAuthSuccess() {
  $("#login").classList.add("hidden");
  startApp();
}

// ========================= Shaxsiy (config) =========================
function applyTheme() {
  if (!CFG.themeColor) return;
  const c = CFG.themeColor, root = document.documentElement.style;
  root.setProperty("--pink", c);
  root.setProperty("--pink-dark", `color-mix(in srgb, ${c} 78%, black)`);
  root.setProperty("--pink-soft", `color-mix(in srgb, ${c} 22%, white)`);
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", c);
}
function spawnHearts() {
  const bg = $("#hearts-bg"); const emojis = ["❤", "💕", "💗", "💞", "🩷"];
  for (let i = 0; i < 14; i++) {
    const h = document.createElement("span");
    h.className = "fh"; h.textContent = emojis[i % emojis.length];
    h.style.left = Math.random() * 100 + "%";
    h.style.fontSize = 14 + Math.random() * 18 + "px";
    h.style.animationDuration = 9 + Math.random() * 10 + "s";
    h.style.animationDelay = -Math.random() * 15 + "s";
    bg.appendChild(h);
  }
}

// ========================= Boshlash =========================
function boot() {
  applyTheme();
  spawnHearts();
  showLogin();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(AUTH_KEY)); } catch (e) {}
  if (saved && saved.u && saved.p) {
    // avval kirgan — avtomatik login
    $("#login-user").value = saved.u;
    const btn = $("#login-btn"); btn.disabled = true; btn.textContent = "Ulanmoqda...";
    sync.connectAndLogin(saved.u, saved.p);
  }
}

function startApp() {
  $("#app").classList.remove("hidden");
  renderAll();
  renderScore();
  renderBadges();
  renderConnUI();
  go("home");
  maybeShowLetter();
  maybeAskIdentity();
}

// ========================= Profil / kunlar =========================
function renderProfile() {
  $("#hdr-me").textContent = data.profile.me || "Men";
  $("#hdr-partner").textContent = data.profile.partner || "Yor";
}
function renderDays() {
  const start = new Date(data.profile.date), now = new Date();
  const diff = Math.max(0, Math.floor((now - start) / 86400000));
  $("#days-count").textContent = diff.toLocaleString("uz-UZ");
  $("#days-since").textContent = data.profile.date ? `${fmtDate(start)} dan beri` : "";
}

// ========================= Sham =========================
function renderCandle() {
  const c = $("#candle");
  c.classList.toggle("lit", data.candleLit);
  c.classList.toggle("both", sync.bothOnline);
  $("#candle-toggle").textContent = data.candleLit ? "🕯️ Shamni o'chirish" : "🕯️ Shamni yoqish";
}
$("#candle-toggle").addEventListener("click", () => dispatch("CANDLE", { lit: !data.candleLit }));

// ========================= Navigatsiya =========================
let currentView = "home";
function go(view) {
  currentView = view;
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $(`#view-${view}`).classList.remove("hidden");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.go === view));
  if (unseen[view] !== undefined) { unseen[view] = false; renderBadges(); }
  window.scrollTo(0, 0);
}
$$("[data-go]").forEach((el) => el.addEventListener("click", () => go(el.dataset.go)));

// ========================= Savollar =========================
const Q = window.LOVORA_QUESTIONS;
let currentQ = null;
function pickDaily() {
  const day = todayKey();
  if (!data.dailySeed || data.dailySeed.day !== day) {
    data.dailySeed = { day, index: Math.abs(hash(day)) % Q.length }; save();
  }
  const dq = Q[data.dailySeed.index];
  $("#home-daily-q").textContent = dq.q;
  showQuestion(dq);
}
function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; } return h; }
function showQuestion(q) { currentQ = q; $("#q-cat").textContent = q.cat; $("#q-text").textContent = q.q; $("#q-answer").value = ""; }
$("#q-next").addEventListener("click", () => showQuestion(Q[Math.floor(Math.random() * Q.length)]));
$("#q-save").addEventListener("click", () => {
  const a = $("#q-answer").value.trim();
  if (!a || !currentQ) return;
  dispatch("ANSWER_ADD", { id: uid(), cat: currentQ.cat, q: currentQ.q, a, by: currentPerson(), ts: Date.now() });
  $("#q-answer").value = ""; flash($("#q-save"), "Saqlandi ✓");
});
function renderAnswers() {
  const box = $("#q-history");
  if (!data.answers.length) { box.innerHTML = `<p class="empty">Hali javob yo'q. Birinchi savolga javob bering 💕</p>`; return; }
  box.innerHTML = data.answers.map((a) => `
    <div class="q-item">
      <div class="qq">${esc(a.q)}</div>
      <div class="qa">${esc(a.a)}</div>
      <div class="qd">${a.by ? "✍️ " + esc(a.by) + " · " : ""}${fmtDate(a.ts)}</div>
    </div>`).join("");
}

// ========================= Xatlar =========================
$("#note-send").addEventListener("click", () => {
  const t = $("#note-input").value.trim();
  if (!t) return;
  dispatch("NOTE_ADD", { id: uid(), text: t, by: currentPerson(), ts: Date.now() });
  $("#note-input").value = "";
});
function renderNotes() {
  const box = $("#notes-list");
  if (!data.notes.length) { box.innerHTML = `<p class="empty">Hali xat yo'q. Yoringizga birinchi so'zni yozing 💌</p>`; return; }
  box.innerHTML = data.notes.map((n) => `
    <div class="note">
      <div class="note-text">${esc(n.text)}</div>
      <div class="note-meta">
        <span class="note-date">${n.by ? "💗 " + esc(n.by) + " · " : ""}${fmtDate(n.ts)}</span>
        <button class="note-del" data-del-note="${n.id}">🗑️</button>
      </div>
    </div>`).join("");
  $$("[data-del-note]").forEach((b) => b.addEventListener("click", () => dispatch("NOTE_DEL", { id: b.dataset.delNote })));
}

// ========================= Xotiralar =========================
let pendingPhoto = null;
$("#mem-photo").addEventListener("change", (e) => {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = () => { pendingPhoto = r.result; const p = $("#mem-preview"); p.src = pendingPhoto; p.classList.remove("hidden"); };
  r.readAsDataURL(file);
});
$("#mem-save").addEventListener("click", () => {
  const title = $("#mem-title").value.trim(), text = $("#mem-text").value.trim();
  if (!title && !text && !pendingPhoto) return;
  dispatch("MEM_ADD", { id: uid(), title, text, photo: pendingPhoto, by: currentPerson(), ts: Date.now() });
  $("#mem-title").value = ""; $("#mem-text").value = ""; $("#mem-photo").value = ""; pendingPhoto = null;
  $("#mem-preview").classList.add("hidden");
});
function renderMemories() {
  const box = $("#mem-list");
  if (!data.memories.length) { box.innerHTML = `<p class="empty">Hali xotira yo'q. Birinchi xotirangizni saqlang 📸</p>`; return; }
  box.innerHTML = data.memories.map((m) => `
    <div class="mem">
      ${m.photo ? `<img src="${m.photo}" alt="">` : ""}
      <div class="mem-body">
        ${m.title ? `<h4>${esc(m.title)}</h4>` : ""}
        ${m.text ? `<p>${esc(m.text)}</p>` : ""}
        <div class="mem-date">${m.by ? esc(m.by) + " · " : ""}${fmtDate(m.ts)} · <span data-del-mem="${m.id}" style="cursor:pointer">o'chirish</span></div>
      </div>
    </div>`).join("");
  $$("[data-del-mem]").forEach((b) => b.addEventListener("click", () => dispatch("MEM_DEL", { id: b.dataset.delMem })));
}

// ========================= O'yin (jonli) =========================
function renderBoard() {
  const t = data.ttt, el = $("#ttt-board");
  el.innerHTML = "";
  for (let i = 0; i < 9; i++) {
    const c = document.createElement("button");
    c.className = "ttt-cell" + (t.winLine && t.winLine.includes(i) ? " win" : "");
    c.textContent = t.board[i];
    c.addEventListener("click", () => { if (t.over || t.board[i]) return; dispatch("TTT_MOVE", { i }); });
    el.appendChild(c);
  }
  $("#ttt-turn").textContent = t.over ? "" : `Navbat: ${t.turn}`;
  if (t.over) { const w = tttWinner(t.board); $("#ttt-status").textContent = w ? `${w.mark} yutdi! 🎉` : "Durrang! 🤝"; }
  else $("#ttt-status").textContent = "";
  renderScore();
}
function renderScore() { $("#ttt-p1").textContent = `❌ ${data.ttt.p1}`; $("#ttt-p2").textContent = `⭕ ${data.ttt.p2}`; }
$("#ttt-reset").addEventListener("click", () => dispatch("TTT_RESET", {}));

// ========================= Sozlamalar =========================
$("#btn-settings").addEventListener("click", () => {
  $("#set-me").value = data.profile.me;
  $("#set-partner").value = data.profile.partner;
  $("#set-date").value = data.profile.date;
  renderConnUI();
  $("#settings-modal").classList.remove("hidden");
});
$("#set-close").addEventListener("click", () => $("#settings-modal").classList.add("hidden"));
$("#set-save").addEventListener("click", () => {
  const me = $("#set-me").value.trim() || data.profile.me;
  const partner = $("#set-partner").value.trim() || data.profile.partner;
  const date = $("#set-date").value || data.profile.date;
  dispatch("PROFILE_SET", { me, partner, date });
  $("#settings-modal").classList.add("hidden");
});
$("#set-logout").addEventListener("click", () => {
  if (confirm("Chiqasizmi? Qayta login qilishingiz kerak bo'ladi.")) { sync.logout(); location.reload(); }
});
function renderConnUI() {
  const st = $("#pair-status");
  if (!sync.coupleId) { st.textContent = "Ulanmagan"; st.classList.remove("ok"); }
  else if (sync.bothOnline) { st.textContent = "Ikkalangiz onlayn — jonli sinxron 💚"; st.classList.add("ok"); }
  else { st.textContent = "Ulangan — yoringiz kutilmoqda"; st.classList.remove("ok"); }
  $("#pair-iam").textContent = iam ? `Bu qurilma: ${iam}` : "";
}

// ========================= Ochilish xati =========================
const LETTER_KEY = "lovora_letter_seen";
function fillLetter() {
  $("#letter-text").textContent = (CFG.openingLetter || "").trim();
  const sign = CFG.letterSign || (CFG.me ? `Sening ${CFG.me} ❤` : "");
  $("#letter-sign").textContent = sign ? `— ${sign}` : "";
}
function maybeShowLetter() { if (CFG.openingLetter && !localStorage.getItem(LETTER_KEY)) openLetter(); }
function openLetter() {
  fillLetter();
  $("#envelope").classList.remove("open", "hidden");
  $("#letter-paper").classList.add("hidden");
  $("#letter-overlay").classList.remove("hidden");
}
$("#envelope").addEventListener("click", () => {
  $("#envelope").classList.add("open");
  setTimeout(() => { $("#envelope").classList.add("hidden"); $("#letter-paper").classList.remove("hidden"); heartRain(18); }, 550);
});
$("#letter-close").addEventListener("click", () => {
  $("#letter-overlay").classList.add("hidden");
  localStorage.setItem(LETTER_KEY, "1");
  maybeAskIdentity();
});
$("#btn-letter").addEventListener("click", openLetter);

// ========================= Kim bu qurilmada? =========================
function maybeAskIdentity() {
  if (iam || !CFG.me || !CFG.partner) return;
  if (!$("#letter-overlay").classList.contains("hidden")) return;
  $("#id-btn-me").textContent = CFG.me;
  $("#id-btn-partner").textContent = CFG.partner;
  $("#identity-modal").classList.remove("hidden");
}
function setIdentity(name) { iam = name; localStorage.setItem(IAM_KEY, name); $("#identity-modal").classList.add("hidden"); renderConnUI(); }
$("#id-btn-me").addEventListener("click", () => setIdentity(CFG.me));
$("#id-btn-partner").addEventListener("click", () => setIdentity(CFG.partner));

// ========================= Yurak yomg'iri =========================
function heartRain(n) {
  const items = ["💖", "💕", "🎉", "✨", "💗", "🌸"];
  for (let i = 0; i < n; i++) {
    const el = document.createElement("span");
    el.className = "confetti"; el.textContent = items[Math.floor(Math.random() * items.length)];
    el.style.left = Math.random() * 100 + "vw";
    el.style.animationDuration = 2 + Math.random() * 2.5 + "s";
    el.style.animationDelay = Math.random() * 0.5 + "s";
    document.body.appendChild(el); setTimeout(() => el.remove(), 5000);
  }
}

// ========================= Song =========================
let songPlaying = false;
function renderSong() { $("#song-card").classList.toggle("hidden", !CFG.songYoutubeId); }
$("#song-toggle").addEventListener("click", () => {
  const player = $("#song-player"), btn = $("#song-toggle");
  if (songPlaying) {
    player.innerHTML = ""; player.classList.add("hidden"); btn.textContent = "▶";
    $("#song-hint").textContent = "Tinglash uchun bosing"; songPlaying = false;
  } else {
    const id = encodeURIComponent(CFG.songYoutubeId);
    player.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    player.classList.remove("hidden"); btn.textContent = "⏸";
    $("#song-hint").textContent = "Ijro etilyapti..."; songPlaying = true;
  }
});

// ========================= Yordamchilar =========================
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function flash(btn, text) { const old = btn.textContent; btn.textContent = text; setTimeout(() => (btn.textContent = old), 1200); }

renderSong();
boot();
