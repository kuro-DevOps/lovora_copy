# 💞 Lovora — juftliklar uchun web-app

Juftliklar uchun mo'ljallangan ilova: birga o'tkazgan kunlar, sham rejimi, juftlik
savollari, sevgi xatlari, xotiralar va ikki kishilik o'yin — barchasi **ikki qurilma
o'rtasida real-time sinxronlanadi**.

## Xususiyatlar

- 🏠 **Birga o'tkazgan kunlar** hisoblagichi
- 🕯️ **Sham rejimi** — ikkalangiz onlayn bo'lsangiz yorqinroq yonadi
- 💬 **Juftlik savollari** — kunlik savol + 30 ta o'zbekcha savol, javoblar saqlanadi
- 💌 **Sevgi xatlari**
- 📸 **Xotiralar tasmasi** — rasm bilan
- 🎮 **Tic-Tac-Toe** — ikki qurilmada jonli o'ynaladi
- 💑 **Juftlik kodi** orqali ulanish (real-time WebSocket sync)
- 🌙 Dark mode, mobil dizayn, offline ham ishlaydi

## Texnologiya

- **Frontend:** sof HTML/CSS/JS (framework yo'q)
- **Backend:** Node.js + `ws` (WebSocket), statik fayllarni ham o'zi tarqatadi
- **Saqlash:** har bir juftlik holati serverda `data/<KOD>.json` faylida;
  qurilmada esa `localStorage` (offline uchun)

## Ishga tushirish

```bash
npm install
npm start
```

So'ng brauzerda: **http://localhost:4211**

## Qanday ishlatiladi

1. Ismlar va munosabatlar boshlangan sanani kiriting.
2. ⚙️ Sozlamalar → **"Juftlik kodi yaratish"** → kod paydo bo'ladi (masalan `K7M2QX`).
3. Yoringiz o'z telefonida ilovani ochib, ⚙️ Sozlamalar → kodni kiritib **"Ulanish"**.
4. Endi sham, xatlar, savollar, xotiralar va o'yin ikkalangizda real-time sinxron!

## 🚂 Railway'ga joylashtirish (tavsiya)

1. Kodni GitHub'ga yuklang (repo yarating, push qiling).
2. [railway.com](https://railway.com) → **New Project → Deploy from GitHub repo** → repongizni tanlang.
3. Railway avtomatik aniqlaydi (Node), `npm start` bilan ishga tushiradi. Port avtomatik.
4. **MUHIM — ma'lumot o'chib ketmasligi uchun:**
   - Service → **Variables** → `DATA_DIR` = `/data`
   - Service → **Volumes** (o'ng menyu) → **New Volume** → Mount path: `/data`
   - Shunda xatlar/xotiralar har deploy'da saqlanib qoladi (Volume'siz o'chadi!).
5. Settings → **Generate Domain** → sizga `...up.railway.app` linki beriladi.
6. Yoringiz shu linkni telefonida ochadi. Tayyor! 💕

> Havola HTTPS bo'lgani uchun WebSocket avtomatik `wss://` ga o'tadi — hech narsa
> sozlash shart emas.

## Boshqa serverga joylashtirish

Ilova bitta portda ishlaydi, shuning uchun joylashtirish oson:

```bash
# serverda
git clone / yuklash
npm install --production
PORT=4211 node server.js
```

nginx orqali reverse proxy (WebSocket'ni ham o'tkazadi):

```nginx
location / {
    proxy_pass http://localhost:4211;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Doimiy ishlashi uchun `pm2 start server.js --name lovora` yoki Docker ishlating.

## Keyingi g'oyalar

- Ko'proq o'yinlar (shaxmat, "4 dona ketma-ret", "Dengiz jangi")
- Rasm/ovozli xabarlar, push-bildirishnomalar
- Rasmlarni fayl sifatida saqlash (hozircha dataURL)
- Androidga o'tkazish (Capacitor / WebView)
