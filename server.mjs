// Ghost Lady — servidor local (sem dependências).
// Serve o site em ./ghost-lady e substitui a API do Manus (/api/trpc/...).
// Correr:  node server.mjs        (porta: PORT, por omissão 5173)
//
// Variáveis de ambiente (todas opcionais) — ver LEIA-ME.md:
//   ADMIN_KEY                     palavra secreta para /guestbook/moderation?key=...
//   UPSTASH_REDIS_REST_URL/TOKEN  guardar os dados no Upstash (para o Render grátis)
//   SPOTIFY_CLIENT_ID/SECRET      "a ouvir agora"; redirect URI = <site>/api/spotify/callback

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, "ghost-lady");
const FALLBACKS = path.join(ROOT, "fallback-images");
const DATA = path.join(ROOT, "data");
const PORT = Number(process.env.PORT || 5173);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const SP_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SP_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";

fs.mkdirSync(DATA, { recursive: true });

// ---------- armazenamento ----------
// Ficheiros JSON em ./data e, se UPSTASH_REDIS_REST_URL/TOKEN estiverem definidos,
// também no Upstash Redis (para os dados sobreviverem a reinícios no Render grátis).
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const useUpstash = Boolean(UP_URL && UP_TOKEN);

async function upstash(command) {
  const r = await fetch(UP_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}
async function load(name, def) {
  if (useUpstash) {
    try {
      const v = await upstash(["GET", `ghostlady:${name}`]);
      if (v) return JSON.parse(v);
    } catch (e) { console.error("Não consegui ler do Upstash:", e.message); }
  }
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name + ".json"), "utf8")); }
  catch { return def; }
}
function save(name, value) {
  const json = JSON.stringify(value);
  const file = path.join(DATA, name + ".json");
  fs.writeFileSync(file + ".tmp", json);
  fs.renameSync(file + ".tmp", file);
  if (useUpstash) upstash(["SET", `ghostlady:${name}`, json]).catch((e) => console.error("Não consegui gravar no Upstash:", e.message));
}
const db = {
  guestbook: await load("guestbook", []),  // {id,name,message,status,createdAt}
  visitors: await load("visitors", { ids: [], total: 0 }),
  messages: await load("messages", []),
  spotify: await load("spotify", {}),      // {refreshToken, accessToken, expiresAt}
};

// ---------- erros tRPC ----------
class ApiError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
const bad = (m) => new ApiError("BAD_REQUEST", m, 400);
const forbidden = () => new ApiError("FORBIDDEN", "Só a dona da casa pode moderar o livro de visitas.", 403);

function isAdmin(req, url) {
  const ip = req.socket.remoteAddress || "";
  // atrás de um proxy (Render, etc.) nunca se confia no endereço local
  const local = !req.headers["x-forwarded-for"] && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");
  const key = url.searchParams.get("key") || (req.headers.referer && new URL(req.headers.referer).searchParams.get("key"));
  return local || (ADMIN_KEY && key === ADMIN_KEY);
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ---------- procedimentos ----------
const procedures = {
  "guestbook.list": () =>
    db.guestbook.filter((e) => e.status === "approved")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, name, message, createdAt }) => ({ id, name, message, createdAt })),

  "guestbook.submit": (input) => {
    if (str(input?.website, 200)) return { success: true }; // honeypot anti-spam
    const name = str(input?.name, 60);
    const message = typeof input?.message === "string" ? input.message : "";
    if (!name) throw bad("Escreve o teu nome antes de deixares a tua marca.");
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(message) || message.length > 800_000)
      throw bad("O desenho não é válido ou é demasiado grande.");
    db.guestbook.push({ id: crypto.randomUUID(), name, message, status: "pending", createdAt: new Date().toISOString() });
    save("guestbook", db.guestbook);
    return { success: true };
  },

  "guestbook.moderation.list": (_i, ctx) => {
    if (!ctx.admin) throw forbidden();
    return [...db.guestbook].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  "guestbook.moderation.setStatus": (input, ctx) => {
    if (!ctx.admin) throw forbidden();
    const entry = db.guestbook.find((e) => e.id === input?.id);
    if (!entry) throw new ApiError("NOT_FOUND", "Desenho não encontrado.", 404);
    if (!["approved", "rejected", "pending"].includes(input?.status)) throw bad("Estado inválido.");
    entry.status = input.status;
    save("guestbook", db.guestbook);
    return { success: true };
  },

  "visitors.register": (input) => {
    const id = str(input?.visitorId, 100);
    if (id && !db.visitors.ids.includes(id)) {
      db.visitors.ids.push(id);
      db.visitors.total = db.visitors.ids.length;
      save("visitors", db.visitors);
    }
    return db.visitors.total;
  },

  "contact.send": (input) => {
    const name = str(input?.name, 100), email = str(input?.email, 200), message = str(input?.message, 5000);
    if (!name || !message) throw bad("Preenche o nome e a mensagem.");
    db.messages.push({ name, email, message, createdAt: new Date().toISOString() });
    save("messages", db.messages);
    console.log(`✉  Nova mensagem de ${name} <${email}> — ver data/messages.json`);
    return { success: true };
  },

  "spotify.currentlyPlaying": () => currentlyPlaying(),
};

// ---------- Spotify ----------
let spotifyCache = { at: 0, value: null };
async function spotifyToken() {
  const s = db.spotify;
  if (!s.refreshToken) return null;
  if (s.accessToken && s.expiresAt > Date.now() + 30_000) return s.accessToken;
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${SP_ID}:${SP_SECRET}`).toString("base64") },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refreshToken }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  s.accessToken = j.access_token;
  s.expiresAt = Date.now() + j.expires_in * 1000;
  if (j.refresh_token) s.refreshToken = j.refresh_token;
  save("spotify", s);
  return s.accessToken;
}
async function currentlyPlaying() {
  const isConfigured = Boolean(SP_ID && SP_SECRET && db.spotify.refreshToken);
  const empty = { isConfigured, isPlaying: false, track: null };
  if (!isConfigured) return empty;
  if (Date.now() - spotifyCache.at < 10_000) return spotifyCache.value;
  let value = empty;
  try {
    const token = await spotifyToken();
    if (token) {
      const r = await fetch("https://api.spotify.com/v1/me/player/currently-playing", { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 200) {
        const j = await r.json();
        const t = j.item;
        if (t) value = {
          isConfigured, isPlaying: Boolean(j.is_playing),
          track: {
            title: t.name,
            artist: t.artists ? t.artists.map((a) => a.name).join(", ") : (t.show?.publisher || ""),
            album: t.album?.name || t.show?.name || "",
            albumCover: t.album?.images?.[0]?.url || t.images?.[0]?.url || null,
            url: t.external_urls?.spotify || null,
          },
        };
      }
    }
  } catch (e) { console.warn("Spotify:", e.message); }
  spotifyCache = { at: Date.now(), value };
  return value;
}
function spotifyRedirectUri(req) {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host.replace("localhost", "127.0.0.1")}/api/spotify/callback`;
}
let spotifyState = "";
async function handleSpotify(req, res, url) {
  if (!SP_ID || !SP_SECRET)
    return sendText(res, 200, "O Spotify ainda não está configurado.\nDefine SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET e reinicia o servidor (ver LEIA-ME.md).");
  if (url.pathname === "/api/spotify/connect") {
    if (!isAdmin(req, url)) return sendText(res, 403, "Só a dona da casa pode ligar o Spotify. Abre /api/spotify/connect?key=<ADMIN_KEY>.");
    spotifyState = crypto.randomUUID();
    const auth = new URL("https://accounts.spotify.com/authorize");
    auth.search = new URLSearchParams({
      response_type: "code", client_id: SP_ID, state: spotifyState,
      scope: "user-read-currently-playing user-read-playback-state",
      redirect_uri: spotifyRedirectUri(req),
    });
    res.writeHead(302, { Location: auth.toString() }); return res.end();
  }
  if (url.pathname === "/api/spotify/callback") {
    if (!spotifyState || url.searchParams.get("state") !== spotifyState) return sendText(res, 400, "Pedido inválido (state).");
    spotifyState = "";
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${SP_ID}:${SP_SECRET}`).toString("base64") },
      body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: spotifyRedirectUri(req) }),
    });
    if (!r.ok) return sendText(res, 502, "O Spotify recusou a ligação: " + (await r.text()));
    const j = await r.json();
    db.spotify = { refreshToken: j.refresh_token, accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    save("spotify", db.spotify);
    spotifyCache.at = 0;
    res.writeHead(302, { Location: "/" }); return res.end();
  }
  sendText(res, 404, "Not found");
}

// ---------- tRPC (httpBatchLink + superjson) ----------
async function readBody(req, limit = 2_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw bad("Pedido demasiado grande."); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}
async function handleTrpc(req, res, url) {
  const names = decodeURIComponent(url.pathname.slice("/api/trpc/".length)).split(",");
  let inputs = {};
  try {
    if (req.method === "GET") inputs = JSON.parse(url.searchParams.get("input") || "{}");
    else { const b = await readBody(req); inputs = b ? JSON.parse(b) : {}; }
  } catch (e) { inputs = {}; }
  const ctx = { admin: isAdmin(req, url) };
  const out = await Promise.all(names.map(async (name, i) => {
    const raw = inputs[i] ?? inputs[String(i)];
    const input = raw && typeof raw === "object" && "json" in raw ? raw.json : raw;
    try {
      const fn = procedures[name];
      if (!fn) throw new ApiError("NOT_FOUND", `Procedimento desconhecido: ${name}`, 404);
      const data = await fn(input, ctx);
      return { result: { data: { json: data ?? null } } };
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("INTERNAL_SERVER_ERROR", "Erro interno.", 500);
      if (!(e instanceof ApiError)) console.error(e);
      return { error: { json: { message: err.message, code: -32600, data: { code: err.code, httpStatus: err.status, path: name } } } };
    }
  }));
  const status = out.every((o) => o.error) ? out[0].error.json.data.httpStatus : 200;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(out));
}

// ---------- ficheiros estáticos ----------
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".woff2": "font/woff2",
};
function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); res.end(text);
}
function sendFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, "Not found");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": cache ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
}
function safeJoin(base, p) {
  const full = path.join(base, p);
  return full.startsWith(base + path.sep) ? full : null;
}
function handleStatic(req, res, url) {
  const p = decodeURIComponent(url.pathname);
  const file = safeJoin(SITE, p);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file, p.startsWith("/assets/"));
  // imagens que ficaram no armazenamento do Manus: usa a substituta em fallback-images/
  if (p.startsWith("/manus-storage/")) {
    const base = path.basename(p, path.extname(p));
    for (const ext of [".jpg", ".png", ".webp", ".svg"]) {
      const f = path.join(FALLBACKS, base + ext);
      if (fs.existsSync(f)) return sendFile(res, f, false);
    }
    return sendText(res, 404, "Not found");
  }
  if (path.extname(p)) return sendText(res, 404, "Not found");
  sendFile(res, path.join(SITE, "index.html"), false); // rotas da SPA
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/trpc/")) return await handleTrpc(req, res, url);
    if (url.pathname.startsWith("/api/spotify/")) return await handleSpotify(req, res, url);
    if (url.pathname.startsWith("/api/")) return sendText(res, 404, "Not found");
    handleStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendText(res, 500, "Erro interno.");
  }
}).listen(PORT, () => {
  console.log(`👻 Ghost Lady em http://localhost:${PORT}`);
  console.log(`   Moderação: http://localhost:${PORT}/guestbook/moderation`);
  console.log(`   Spotify: ${SP_ID && SP_SECRET ? (db.spotify.refreshToken ? "ligado" : "configurado, falta ligar a conta") : "não configurado"}`);
  console.log(`   Dados: ${useUpstash ? "Upstash Redis + ./data" : "só ./data"}${ADMIN_KEY ? "" : " · ADMIN_KEY não definida (moderação só em localhost)"}`);
});
