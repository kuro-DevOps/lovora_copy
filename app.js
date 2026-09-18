// ========================= Lovora — asosiy mantiq (real-time sync) =========================
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const KEY = "lovora_v1";
const COUPLE_KEY = "lovora_couple";
const CFG = window.LOVORA_CONFIG || {};

// ---- Ma'lumotlar modeli (server bilan bir xil) ----
const defaultData = () => ({
  profile: { me: "", partner: "", date: "" },
  candleLit: false,
  answers: [],   // {id, cat, q, a, ts}
  notes: [],     // {id, text, ts}
  memories: [],  // {id, title, text, photo, ts}
  ttt: { board: Array(9).fill(""), turn: "❌", p1: 0, p2: 0, over: false, winLine: null },
  dailySeed: null,
});

let data = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const d = { ...defaultData(), ...parsed };
    if (!d.ttt || !Array.isArray(d.ttt.board)) d.ttt = defaultData().ttt;
    return d;
  } catch (e) { return null; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
}

// ---- Sana yordamchilari ----
const UZ_MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun",
  "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const fmtDate = (ts) => {
  const d = new Date(ts);
  return `${d.getDate()}-${UZ_MONTHS[d.getMonth()]}, ${d.getFullYear()}`;
};
const todayKey = () => new Date().toISOString().slice(0, 10);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ========================= REDUCER (server bilan bir xil) =========================
const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function tttWinner(b) {
  for (const line of WINS) {
    const [a, c, d] = line;
    if (b[a] && b[a] === b[c] && b[a] === b[d]) return { mark: b[a], line };
  }
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
    case "TTT_RESET": {
      const t = data.ttt;
      t.board = Array(9).fill(""); t.turn = "❌"; t.over = false; t.winLine = null; break;
    }
  }
}

// Mahalliy harakat: qo'llaymiz, saqlaymiz, serverga yuboramiz, qayta chizamiz
function dispatch(action, payload) {
  reduce(action, payload);
  save();
  sync.send(action, payload);
  renderFor(action);
}
// Serverdan kelgan delta: faqat qo'llaymiz + chizamiz (qayta yubormaymiz)
function applyRemote(action, payload) {
  reduce(action, payload);
  save();
  renderFor(action);
}

function renderFor(action) {
  if (action.startsWith("TTT")) { renderBoard(); return; }
  if (action === "CANDLE") { renderCandle(); return; }
  if (action === "ANSWER_ADD") { renderAnswers(); return; }
  if (action.startsWith("NOTE")) { renderNotes(); return; }
  if (action.startsWith("MEM")) { renderMemories(); return; }
  if (action === "PROFILE_SET") { renderProfile(); renderDays(); return; }
  renderAll();
}
function renderAll() {
  renderProfile(); renderDays(); renderCandle(); pickDaily();
  renderAnswers(); renderNotes(); renderMemories(); renderBoard();
}

// ========================= SYNC (WebSocket) =========================
const sync = {
  ws: null,
  coupleId: localStorage.getItem(COUPLE_KEY) || null,
  bothOnline: false,

  url() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
  },

  connect() {
    if (!this.coupleId) return;
    this._open(() => this._raw({ type: "join", coupleId: this.coupleId }));
  },

  create() {
    // mavjud mahalliy ma'lumotni serverga urug' qilib yuboramiz
    const snapshot = {
      profile: data.profile, candleLit: data.candleLit,
      answers: data.answers, notes: data.notes, memories: data.memories, ttt: data.ttt,
    };
    this._open(() => this._raw({ type: "create", snapshot }));
  },

  join(code) {
    this.coupleId = code.toUpperCase();
    this._open(() => this._raw({ type: "join", coupleId: this.coupleId }));
  },

  leave() {
    localStorage.removeItem(COUPLE_KEY);
    this.coupleId = null;
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.bothOnline = false;
    setConn(false, false);
    renderPairUI();
  },

  _open(onReady) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { onReady(); return; }
    try { this.ws = new WebSocket(this.url()); } catch (e) { return; }
    this.ws.onopen = () => onReady();
    this.ws.onmessage = (ev) => this._onMsg(ev);
    this.ws.onclose = () => { setConn(false, false); this.bothOnline = false; renderCandle(); scheduleReconnect(); };
    this.ws.onerror = () => {};
  },

  _raw(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); },

  send(action, payload) {
    if (this.coupleId) this._raw({ type: "action", action, payload });
  },

  _onMsg(ev) {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "created") {
      this.coupleId = m.coupleId;
      localStorage.setItem(COUPLE_KEY, m.coupleId);
      setConn(true, false);
      renderPairUI();
    } else if (m.type === "state") {
      // serverdagi to'liq holatni qabul qilamiz
      localStorage.setItem(COUPLE_KEY, m.coupleId);
      const seed = data.dailySeed;
      data = { ...defaultData(), ...m.state, dailySeed: seed };
      if (!data.ttt || !Array.isArray(data.ttt.board)) data.ttt = defaultData().ttt;
      save();
      setConn(true, false);
      renderAll(); renderPairUI();
    } else if (m.type === "delta") {
      applyRemote(m.action, m.payload);
    } else if (m.type === "presence") {
      this.bothOnline = m.count >= 2;
      setConn(true, this.bothOnline);
      renderCandle();
    } else if (m.type === "error") {
      if (m.error === "not_found") {
        alert("Bunday juftlik kodi topilmadi. Kodni tekshiring.");
        this.coupleId = null;
        localStorage.removeItem(COUPLE_KEY);
        renderPairUI();
      }
    }
  },
};

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer || !sync.coupleId) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; sync.connect(); }, 3000);
}

function setConn(connected, both) {
  const dot = $("#conn-dot");
  dot.classList.toggle("waiting", connected && !both);
  dot.classList.toggle("both", connected && both);
  dot.title = !connected ? "Ulanmagan" : both ? "Ikkalangiz onlayn 💚" : "Ulangan — yor kutilmoqda";
}

// ========================= Shaxsiy sozlamalar (config) =========================
function applyTheme() {
  if (!CFG.themeColor) return;
  const c = CFG.themeColor;
  const root = document.documentElement.style;
  root.setProperty("--pink", c);
  root.setProperty("--pink-dark", `color-mix(in srgb, ${c} 78%, black)`);
  root.setProperty("--pink-soft", `color-mix(in srgb, ${c} 22%, white)`);
  document.querySelector('meta[name="theme-color"]').setAttribute("content", c);
}

// Uchar yuraklar
function spawnHearts() {
  const bg = $("#hearts-bg");
  const emojis = ["❤", "💕", "💗", "💞", "🩷"];
  for (let i = 0; i < 14; i++) {
    const h = document.createElement("span");
    h.className = "fh";
    h.textContent = emojis[i % emojis.length];
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
  if (!data || !data.profile.me) {
    // config to'ldirilgan bo'lsa — onboardingni o'tkazib yuboramiz
    if (CFG.me && CFG.partner) {
      data = defaultData();
      data.profile = { me: CFG.me, partner: CFG.partner, date: CFG.startDate || todayKey() };
      save();
      startApp();
    } else {
      $("#onboarding").classList.remove("hidden");
      $("#onb-date").value = todayKey();
    }
  } else {
    startApp();
  }
}

$("#onb-start").addEventListener("click", () => {
  const me = $("#onb-me").value.trim();
  const partner = $("#onb-partner").value.trim();
  const date = $("#onb-date").value;
  if (!me || !partner) { shake($("#onb-me").value ? "#onb-partner" : "#onb-me"); return; }
  data = defaultData();
  data.profile = { me, partner, date: date || todayKey() };
  save();
  $("#onboarding").classList.add("hidden");
  startApp();
});

function shake(sel) { const el = $(sel); el.style.borderColor = "#e94574"; el.focus(); }

function startApp() {
  $("#app").classList.remove("hidden");
  renderAll();
  renderScore();
  renderPairUI();
  renderSurprise();
  renderSong();
  go("home");
  sync.connect(); // agar avval ulangan bo'lsa
  maybeShowLetter();
}

// ========================= Bizning qo'shig'imiz =========================
let songPlaying = false;
function renderSong() {
  const card = $("#song-card");
  if (!CFG.songYoutubeId) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
}
$("#song-toggle").addEventListener("click", () => {
  const player = $("#song-player");
  const btn = $("#song-toggle");
  if (songPlaying) {
    player.innerHTML = "";
    player.classList.add("hidden");
    btn.textContent = "▶";
    $("#song-hint").textContent = "Tinglash uchun bosing";
    songPlaying = false;
  } else {
    const id = encodeURIComponent(CFG.songYoutubeId);
    player.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    player.classList.remove("hidden");
    btn.textContent = "⏸";
    $("#song-hint").textContent = "Ijro etilyapti...";
    songPlaying = true;
  }
});

// ========================= Ochilish xati =========================
const LETTER_KEY = "lovora_letter_seen";
function fillLetter() {
  $("#letter-text").textContent = (CFG.openingLetter || "").trim();
  $("#letter-sign").textContent = CFG.me ? `— Sening ${CFG.me} ❤` : "";
}
function maybeShowLetter() {
  if (!CFG.openingLetter) return;
  if (localStorage.getItem(LETTER_KEY)) return;
  openLetter();
}
function openLetter() {
  fillLetter();
  const ov = $("#letter-overlay");
  const env = $("#envelope");
  const paper = $("#letter-paper");
  env.classList.remove("open", "hidden");
  paper.classList.add("hidden");
  ov.classList.remove("hidden");
}
$("#envelope").addEventListener("click", () => {
  $("#envelope").classList.add("open");
  setTimeout(() => {
    $("#envelope").classList.add("hidden");
    $("#letter-paper").classList.remove("hidden");
    heartRain(18);
  }, 550);
});
$("#letter-close").addEventListener("click", () => {
  $("#letter-overlay").classList.add("hidden");
  localStorage.setItem(LETTER_KEY, "1");
});
$("#btn-letter").addEventListener("click", openLetter);

// ========================= Sirli sovg'a =========================
const SURPRISE_KEY = "lovora_surprise_opened";
function daysUntil(dateStr) {
  const target = new Date(dateStr + "T00:00:00");
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / 86400000);
}
function renderSurprise() {
  const s = CFG.surprise;
  const card = $("#surprise-card");
  if (!s || !s.date) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  $("#surprise-title").textContent = s.title || "Sirli sovg'a 🎁";
  const left = daysUntil(s.date);
  const btn = $("#surprise-btn");
  if (left > 0) {
    $("#surprise-sub").textContent = `${left} kundan keyin ochiladi...`;
    btn.classList.add("hidden");
  } else {
    $("#surprise-sub").textContent = "Bugun ochsang bo'ladi 💝";
    btn.classList.remove("hidden");
  }
}
$("#surprise-btn").addEventListener("click", () => {
  const s = CFG.surprise || {};
  $("#sr-title").textContent = s.title || "Sen uchun 🎁";
  $("#sr-message").textContent = (s.message || "").trim();
  $("#surprise-modal").classList.remove("hidden");
  heartRain(40);
  localStorage.setItem(SURPRISE_KEY, "1");
});
$("#sr-close").addEventListener("click", () => $("#surprise-modal").classList.add("hidden"));

// Yurak/konfeti yomg'iri
function heartRain(n) {
  const items = ["💖", "💕", "🎉", "✨", "💗", "🌸"];
  for (let i = 0; i < n; i++) {
    const el = document.createElement("span");
    el.className = "confetti";
    el.textContent = items[Math.floor(Math.random() * items.length)];
    el.style.left = Math.random() * 100 + "vw";
    el.style.animationDuration = 2 + Math.random() * 2.5 + "s";
    el.style.animationDelay = Math.random() * 0.5 + "s";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}

// ========================= Profil / kunlar =========================
function renderProfile() {
  $("#hdr-me").textContent = data.profile.me || "Men";
  $("#hdr-partner").textContent = data.profile.partner || "Yor";
}
function renderDays() {
  const start = new Date(data.profile.date);
  const now = new Date();
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
function go(view) {
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $(`#view-${view}`).classList.remove("hidden");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.go === view));
  window.scrollTo(0, 0);
}
$$("[data-go]").forEach((el) => el.addEventListener("click", () => go(el.dataset.go)));

// ========================= Savollar =========================
const Q = window.LOVORA_QUESTIONS;
let currentQ = null;

function pickDaily() {
  const day = todayKey();
  if (!data.dailySeed || data.dailySeed.day !== day) {
    const idx = Math.abs(hash(day)) % Q.length;
    data.dailySeed = { day, index: idx };
    save();
  }
  const dq = Q[data.dailySeed.index];
  $("#home-daily-q").textContent = dq.q;
  showQuestion(dq);
}
function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; } return h; }
function showQuestion(q) {
  currentQ = q;
  $("#q-cat").textContent = q.cat;
  $("#q-text").textContent = q.q;
  $("#q-answer").value = "";
}
$("#q-next").addEventListener("click", () => showQuestion(Q[Math.floor(Math.random() * Q.length)]));
$("#q-save").addEventListener("click", () => {
  const a = $("#q-answer").value.trim();
  if (!a || !currentQ) return;
  dispatch("ANSWER_ADD", { id: uid(), cat: currentQ.cat, q: currentQ.q, a, ts: Date.now() });
  $("#q-answer").value = "";
  flash($("#q-save"), "Saqlandi ✓");
});
function renderAnswers() {
  const box = $("#q-history");
  if (!data.answers.length) { box.innerHTML = `<p class="empty">Hali javob yo'q. Birinchi savolga javob bering 💕</p>`; return; }
  box.innerHTML = data.answers.map((a) => `
    <div class="q-item">
      <div class="qq">${esc(a.q)}</div>
      <div class="qa">${esc(a.a)}</div>
      <div class="qd">${fmtDate(a.ts)}</div>
    </div>`).join("");
}

// ========================= Xatlar =========================
$("#note-send").addEventListener("click", () => {
  const t = $("#note-input").value.trim();
  if (!t) return;
  dispatch("NOTE_ADD", { id: uid(), text: t, ts: Date.now() });
  $("#note-input").value = "";
});
function renderNotes() {
  const box = $("#notes-list");
  if (!data.notes.length) { box.innerHTML = `<p class="empty">Hali xat yo'q. Yoringizga birinchi so'zni yozing 💌</p>`; return; }
  box.innerHTML = data.notes.map((n) => `
    <div class="note">
      <div class="note-text">${esc(n.text)}</div>
      <div class="note-meta">
        <span class="note-date">${fmtDate(n.ts)}</span>
        <button class="note-del" data-del-note="${n.id}">🗑️</button>
      </div>
    </div>`).join("");
  $$("[data-del-note]").forEach((b) => b.addEventListener("click", () => dispatch("NOTE_DEL", { id: b.dataset.delNote })));
}

// ========================= Xotiralar =========================
let pendingPhoto = null;
$("#mem-photo").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { pendingPhoto = reader.result; const p = $("#mem-preview"); p.src = pendingPhoto; p.classList.remove("hidden"); };
  reader.readAsDataURL(file);
});
$("#mem-save").addEventListener("click", () => {
  const title = $("#mem-title").value.trim();
  const text = $("#mem-text").value.trim();
  if (!title && !text && !pendingPhoto) return;
  dispatch("MEM_ADD", { id: uid(), title, text, photo: pendingPhoto, ts: Date.now() });
  $("#mem-title").value = ""; $("#mem-text").value = "";
  $("#mem-photo").value = ""; pendingPhoto = null;
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
        <div class="mem-date">${fmtDate(m.ts)} · <span data-del-mem="${m.id}" style="cursor:pointer">o'chirish</span></div>
      </div>
    </div>`).join("");
  $$("[data-del-mem]").forEach((b) => b.addEventListener("click", () => dispatch("MEM_DEL", { id: b.dataset.delMem })));
}

// ========================= O'yin: Tic-Tac-Toe (jonli) =========================
function renderBoard() {
  const t = data.ttt;
  const el = $("#ttt-board");
  el.innerHTML = "";
  for (let i = 0; i < 9; i++) {
    const c = document.createElement("button");
    c.className = "ttt-cell" + (t.winLine && t.winLine.includes(i) ? " win" : "");
    c.textContent = t.board[i];
    c.addEventListener("click", () => {
      if (t.over || t.board[i]) return;
      dispatch("TTT_MOVE", { i });
    });
    el.appendChild(c);
  }
  $("#ttt-turn").textContent = t.over ? "" : `Navbat: ${t.turn}`;
  if (t.over) {
    const w = tttWinner(t.board);
    $("#ttt-status").textContent = w ? `${w.mark} yutdi! 🎉` : "Durrang! 🤝";
  } else {
    $("#ttt-status").textContent = "";
  }
  renderScore();
}
function renderScore() {
  $("#ttt-p1").textContent = `❌ ${data.ttt.p1}`;
  $("#ttt-p2").textContent = `⭕ ${data.ttt.p2}`;
}
$("#ttt-reset").addEventListener("click", () => dispatch("TTT_RESET", {}));

// ========================= Sozlamalar + Pairing =========================
$("#btn-settings").addEventListener("click", () => {
  $("#set-me").value = data.profile.me;
  $("#set-partner").value = data.profile.partner;
  $("#set-date").value = data.profile.date;
  renderPairUI();
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
$("#set-reset").addEventListener("click", () => {
  if (confirm("Rostdan ham hamma ma'lumotni o'chirasizmi? Bu qaytarib bo'lmaydi.")) {
    localStorage.removeItem(KEY);
    localStorage.removeItem(COUPLE_KEY);
    location.reload();
  }
});

$("#pair-create").addEventListener("click", () => sync.create());
$("#pair-join-btn").addEventListener("click", () => {
  const code = $("#pair-input").value.trim();
  if (code.length < 4) { $("#pair-input").style.borderColor = "#e94574"; return; }
  sync.join(code);
});
$("#pair-leave").addEventListener("click", () => {
  if (confirm("Ulanishni uzasizmi? Ma'lumotlar qurilmangizda qoladi.")) sync.leave();
});

function renderPairUI() {
  const paired = !!sync.coupleId;
  $("#pair-code-view").classList.toggle("hidden", !paired);
  $("#pair-create").classList.toggle("hidden", paired);
  $(".pair-join").classList.toggle("hidden", paired);
  $("#pair-leave").classList.toggle("hidden", !paired);
  if (paired) {
    $("#pair-code").textContent = sync.coupleId;
    const st = $("#pair-status");
    st.textContent = sync.bothOnline ? "Ikkalangiz onlayn — jonli sinxron 💚" : "Ulangan — yoringiz kutilmoqda";
    st.classList.toggle("ok", sync.bothOnline);
  } else {
    $("#pair-status").textContent = "Ulanmagan — ikki qurilmani birlashtiring";
    $("#pair-status").classList.remove("ok");
  }
}

// ========================= Yordamchilar =========================
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function flash(btn, text) { const old = btn.textContent; btn.textContent = text; setTimeout(() => (btn.textContent = old), 1200); }

boot();
