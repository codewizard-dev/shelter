// Игровой сервер «Бункер 18+». Без внешних зависимостей: нужен только Node.js 18+.
// Запуск: node server.js   (порт задаётся переменной PORT, по умолчанию 3000)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = +process.env.PORT || 3000;
const ROOT = path.join(__dirname, "public");
const SAVE = path.join(__dirname, "data.json");
const ROOM_TTL = 12 * 3600 * 1000; // комнаты живут 12 часов

/* ---------- хранилище документов ---------- */
const docs = new Map(); // path -> object
try {
  const raw = JSON.parse(fs.readFileSync(SAVE, "utf8"));
  for (const [k, v] of Object.entries(raw)) docs.set(k, v);
  console.log("Загружено документов:", docs.size);
} catch (e) {}
let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  fs.writeFile(SAVE, JSON.stringify(Object.fromEntries(docs)), () => {});
}, 10000);

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function validPath(p, even) {
  if (typeof p !== "string" || p.length > 1000) return false;
  const s = p.split("/");
  if (s.some((x) => !SEG.test(x) || x === "." || x === "..")) return false;
  return even ? s.length % 2 === 0 : s.length % 2 === 1;
}
const parentOf = (p) => p.split("/").slice(0, -1).join("/");
const idOf = (p) => p.split("/").pop();
// личные данные data/users/<uid>/... доступны только владельцу
function allowed(p, uid) {
  const s = p.split("/");
  if (s[0] === "data" && s[1] === "users") return s[2] === uid;
  return true;
}
function merge(t, s) {
  for (const k in s) {
    if (s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) {
      if (!t[k] || typeof t[k] !== "object" || Array.isArray(t[k])) t[k] = {};
      merge(t[k], s[k]);
    } else t[k] = s[k];
  }
}
const snapDoc = (p) => ({ id: idOf(p), exists: docs.has(p), data: docs.get(p) || null });
function queryCol(spec, uid) {
  const out = [];
  for (const [p, d] of docs) {
    if (parentOf(p) !== spec.path || !allowed(p, uid)) continue;
    if (spec.where) {
      const [f, op, v] = spec.where;
      if (op === "==" && d[f] !== v) continue;
    }
    out.push({ id: idOf(p), exists: true, data: d });
    if (spec.limit && out.length >= spec.limit) break;
  }
  return out;
}

/* ---------- подключения (Server-Sent Events) ---------- */
const conns = new Map(); // cid -> {res, uid, subs: Map(sid -> spec)}
function send(c, msg) {
  try { c.res.write("data: " + JSON.stringify(msg) + "\n\n"); } catch (e) {}
}
function pushSub(c, sid, spec) {
  if (spec.k === "doc") send(c, { t: "snap", sid, doc: snapDoc(spec.path) });
  else send(c, { t: "snap", sid, docs: queryCol(spec, c.uid) });
}
function changed(p) {
  dirty = true;
  const col = parentOf(p);
  for (const c of conns.values()) {
    if (!allowed(p, c.uid)) continue;
    for (const [sid, spec] of c.subs) {
      if ((spec.k === "doc" && spec.path === p) || (spec.k === "col" && spec.path === col)) pushSub(c, sid, spec);
    }
  }
}
setInterval(() => { for (const c of conns.values()) try { c.res.write(": ping\n\n"); } catch (e) {} }, 25000);

/* ---------- уборка старых комнат ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [p, d] of [...docs]) {
    const s = p.split("/");
    if (s[0] === "rooms" && s.length === 2 && now - (d.created || 0) > ROOM_TTL) {
      for (const q of [...docs.keys()]) if (q === p || q.startsWith(p + "/")) docs.delete(q);
      for (const q of [...docs.keys()]) if (q.startsWith("data/users/") && q.endsWith("/hand_" + s[1])) docs.delete(q);
      dirty = true;
    }
  }
}, 10 * 60 * 1000);

const uidOf = (token) => "u_" + crypto.createHash("sha256").update(String(token)).digest("base64url").slice(0, 22);

/* ---------- API ---------- */
function api(body) {
  const c = conns.get(body.cid);
  const uid = uidOf(body.token || "");
  const p = body.path;
  switch (body.op) {
    case "get":
      if (!validPath(p, true)) throw "invalid_argument";
      return allowed(p, uid) ? snapDoc(p) : { id: idOf(p), exists: false, data: null };
    case "set":
      if (!validPath(p, true) || !allowed(p, uid) || !body.data || typeof body.data !== "object") throw "invalid_argument";
      docs.set(p, body.data); changed(p); return true;
    case "update": {
      if (!validPath(p, true) || !allowed(p, uid) || !docs.has(p)) throw "invalid_argument";
      const d = JSON.parse(JSON.stringify(docs.get(p)));
      merge(d, body.data || {}); docs.set(p, d); changed(p); return true;
    }
    case "del":
      if (!validPath(p, true) || !allowed(p, uid)) throw "invalid_argument";
      docs.delete(p); changed(p); return true;
    case "sub": {
      if (!c) throw "unavailable";
      const spec = body.spec || {};
      if (!validPath(spec.path, spec.k === "doc")) throw "invalid_argument";
      if (!allowed(spec.path + "/x", uid) && spec.k === "col" && spec.path.startsWith("data/users")) throw "invalid_argument";
      if (c.subs.size > 64) throw "resource_exhausted";
      c.subs.set(body.sid, { k: spec.k, path: spec.path, where: spec.where, limit: Math.min(+spec.limit || 0, 1000) });
      pushSub(c, body.sid, c.subs.get(body.sid));
      return true;
    }
    case "unsub":
      if (c) c.subs.delete(body.sid);
      return true;
  }
  throw "invalid_argument";
}

/* ---------- HTTP ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/events") {
    const token = url.searchParams.get("token") || "";
    if (token.length < 16) { res.writeHead(400); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const cid = crypto.randomUUID();
    const c = { res, uid: uidOf(token), subs: new Map() };
    conns.set(cid, c);
    send(c, { t: "welcome", cid, uid: c.uid });
    req.on("close", () => conns.delete(cid));
    return;
  }

  if (url.pathname === "/api" && req.method === "POST") {
    let raw = "";
    req.on("data", (ch) => { raw += ch; if (raw.length > 300000) req.destroy(); });
    req.on("end", () => {
      let out;
      try { out = { ok: true, data: api(JSON.parse(raw)) }; }
      catch (e) { out = { ok: false, err: typeof e === "string" ? e : "invalid_argument" }; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
    return;
  }

  // статика
  let f = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/" ) f = path.join(ROOT, "index.html");
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, () => console.log("Бункер 18+ запущен: http://localhost:" + PORT));
