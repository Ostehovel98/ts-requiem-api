import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { records, saveRecords } from "./store.js";

const fastify = Fastify({
  logger: true,
  ignoreTrailingSlash: true
});

await fastify.register(cors, { origin: true });

await fastify.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const GHOST_DIR = path.resolve("data/ghosts");
fs.mkdirSync(GHOST_DIR, { recursive: true });

// Stable numeric IDs until you move to Postgres
function nextId() {
  const max = records.reduce((m, r) => Math.max(m, Number(r.id ?? 0)), 0);
  return max + 1;
}

fastify.get("/", async () => ({ ok: true, hint: "Try /health or /getRecords" }));
fastify.get("/health", async () => ({ ok: true, name: "ts-requiem-api" }));

// --------------------
// /leaderboard (JSON)
// --------------------
const leaderboardSchema = z.object({
  driver__steamID64: z.string(),
  name: z.string(),
  car: z.number().int(),
  track: z.number().int(),
  layout: z.number().int(),
  condition: z.number().int(),
  weather: z.number().int(),
  timing: z.number(),
  ghostLength: z.number().int()
});

fastify.post("/leaderboard", async (req, reply) => {
  const parsed = leaderboardSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
  }

  const p = parsed.data;

  // "Best time wins" for same combo + same driver
  const keyMatch = (r) =>
    r.driver__steamID64 === p.driver__steamID64 &&
    r.track === p.track &&
    r.layout === p.layout &&
    r.condition === p.condition &&
    r.weather === p.weather &&
    r.car === p.car;

  const existing = records.find(keyMatch);

  if (!existing) {
    records.push({
      id: nextId(),
      ...p,
      ghostPath: null,
      sha256: null,
      size: null,
      createdAt: new Date().toISOString()
    });
    saveRecords();
    return { ok: true, status: "created" };
  }

  if (p.timing < existing.timing) {
    existing.timing = p.timing;
    existing.ghostLength = p.ghostLength;
    existing.name = p.name;
    existing.createdAt = new Date().toISOString();
    saveRecords();
    return { ok: true, status: "updated_best" };
  }

  return { ok: true, status: "ignored_slower" };
});

// --------------------
// /ghost (multipart)
// --------------------
fastify.post("/ghost", async (req, reply) => {
  const parts = req.parts();

  let ghostBuffer = null;
  const fields = {};

  for await (const part of parts) {
    if (part.type === "file") {
      if (part.fieldname !== "ghost") continue;

      const chunks = [];
      for await (const chunk of part.file) chunks.push(chunk);
      ghostBuffer = Buffer.concat(chunks);
    } else {
      fields[part.fieldname] = part.value;
    }
  }

  if (!ghostBuffer) {
    return reply.code(400).send({ ok: false, error: "Missing ghost file field 'ghost'." });
  }

  // Required fields (based on your mod)
  const required = [
    "driver__steamID64",
    "name",
    "car",
    "track",
    "layout",
    "condition",
    "weather",
    "timing",
    "ghostLength",
    "sha256",
    "size"
  ];
  for (const k of required) {
    if (!(k in fields)) {
      return reply.code(400).send({ ok: false, error: `Missing field '${k}'.` });
    }
  }

  // Validate sha256 against uploaded bytes
  const computed = crypto.createHash("sha256").update(ghostBuffer).digest("hex");
  const provided = String(fields.sha256).toLowerCase();
  if (computed !== provided) {
    return reply.code(400).send({ ok: false, error: "sha256 mismatch", computed, provided });
  }

  const track = Number(fields.track);
  const layout = Number(fields.layout);
  const condition = Number(fields.condition);
  const weather = Number(fields.weather);
  const car = Number(fields.car);
  const timing = Number(fields.timing);
  const ghostLength = Number(fields.ghostLength);

  // IMPORTANT: don’t trust client size; compute real size
  const size = ghostBuffer.length;

  // Save ghost file locally (MVP)
  const filename = `${provided}.bin`;
  const filePath = path.join(GHOST_DIR, filename);
  fs.writeFileSync(filePath, ghostBuffer);

  const steamId = String(fields.driver__steamID64);
  const name = String(fields.name);

  // Attach to matching record for same driver+combo
  const rec = records.find(
    (r) =>
      r.driver__steamID64 === steamId &&
      r.track === track &&
      r.layout === layout &&
      r.condition === condition &&
      r.weather === weather &&
      r.car === car
  );

  if (rec) {
    rec.ghostPath = filePath;
    rec.sha256 = provided;
    rec.size = size;
    rec.timing = timing;
    rec.ghostLength = ghostLength;
    rec.name = name;
    rec.createdAt = new Date().toISOString();
  } else {
    // If /leaderboard wasn’t called first, create it here
    records.push({
      id: nextId(),
      driver__steamID64: steamId,
      name,
      car,
      track,
      layout,
      condition,
      weather,
      timing,
      ghostLength,
      ghostPath: filePath,
      sha256: provided,
      size,
      createdAt: new Date().toISOString()
    });
  }

  saveRecords();
  return { ok: true, storedAs: filename, size };
});

// --------------------
// /ghost/bytes (binary)
// --------------------
fastify.get("/ghost/bytes", async (req, reply) => {
  const q = req.query || {};
  const track = Number(q.track ?? 0);
  const layout = Number(q.layout ?? 0);
  const condition = Number(q.condition ?? 0);
  const weather = Number(q.weather ?? 0);
  const car = Number(q.car ?? 0);
  const steamid = q.steamid ? String(q.steamid) : null;

  let candidates = records.filter(
    (r) =>
      r.track === track &&
      r.layout === layout &&
      r.condition === condition &&
      r.weather === weather &&
      r.car === car &&
      r.ghostPath
  );

  if (steamid) candidates = candidates.filter((r) => r.driver__steamID64 === steamid);

  if (candidates.length === 0) {
    return reply.code(404).send("ghost not found");
  }

  candidates.sort((a, b) => a.timing - b.timing);
  const best = candidates[0];

  const buf = fs.readFileSync(best.ghostPath);
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Length", String(buf.length));
  return reply.send(buf);
});

// --------------------
// /getRecords (TS-compatible shape)
// --------------------
fastify.get("/getRecords", async (req) => {
  const q = req.query || {};

  // Official uses -1 as wildcard for some filters
  const track = Number(q.track ?? -1);
  const layout = Number(q.layout ?? -1);
  const condition = Number(q.condition ?? -1);
  const weather = Number(q.weather ?? -1);
  const car = Number(q.car ?? -1);

  const match = (wanted, actual) => (wanted === -1 ? true : wanted === actual);

  let list = records.filter(
    (r) =>
      match(track, r.track) &&
      match(layout, r.layout) &&
      match(condition, r.condition) &&
      match(weather, r.weather) &&
      match(car, r.car)
  );

  list.sort((a, b) => a.timing - b.timing);

  const out = list.map((r) => ({
    id: Number(r.id ?? 0),
    driver__steamID64: r.driver__steamID64,
    car: r.car,
    track: r.track,
    layout: r.layout,
    condition: r.condition,
    weather: r.weather,
    timing: r.timing,
    ...(r.name ? { name: r.name } : {})
  }));

  return { records: out };
});

fastify.listen({ port: PORT, host: HOST });
