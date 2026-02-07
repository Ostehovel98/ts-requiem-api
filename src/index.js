import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { records, saveRecords } from "./store.js";

// R2 (S3-compatible)
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

const fastify = Fastify({
  logger: true,
  // Important: this makes `/getRecords/` work the same as `/getRecords`
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

// ---- Local fallback dir (only used if R2 is not configured)
const LOCAL_GHOST_DIR = path.resolve("data/ghosts");
fs.mkdirSync(LOCAL_GHOST_DIR, { recursive: true });

// ---- R2 config (Cloudflare R2)
const R2_ENDPOINT = process.env.R2_ENDPOINT || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";
const R2_REGION = process.env.R2_REGION || "auto";

const R2_ENABLED =
  !!R2_ENDPOINT && !!R2_ACCESS_KEY_ID && !!R2_SECRET_ACCESS_KEY && !!R2_BUCKET;

const s3 = R2_ENABLED
  ? new S3Client({
      region: R2_REGION,
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
      },
      forcePathStyle: true
    })
  : null;

// Stable numeric IDs until you move to Postgres
function nextId() {
  const max = records.reduce((m, r) => Math.max(m, Number(r.id ?? 0)), 0);
  return max + 1;
}

fastify.get("/", async () => ({
  ok: true,
  hint: "Try /health or /getRecords",
  r2Enabled: R2_ENABLED
}));

fastify.get("/health", async () => ({
  ok: true,
  name: "ts-requiem-api",
  r2Enabled: R2_ENABLED
}));

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
      ghostKey: null,   // R2 key e.g. "ghosts/<sha>.tsreplay"
      ghostPath: null,  // local fallback path
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
// Upload ghost bytes to R2 (preferred) or local disk (fallback)
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

  // Always trust actual bytes length
  const size = ghostBuffer.length;

  const steamId = String(fields.driver__steamID64);
  const name = String(fields.name);

  // Store with .tsreplay extension
  const objectKey = `ghosts/${provided}.tsreplay`;

  let storedWhere = "none";
  let localPath = null;

  if (R2_ENABLED) {
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: objectKey,
        Body: ghostBuffer,
        ContentType: "application/octet-stream"
      })
    );
    storedWhere = "r2";
  } else {
    const filename = `${provided}.tsreplay`;
    localPath = path.join(LOCAL_GHOST_DIR, filename);
    fs.writeFileSync(localPath, ghostBuffer);
    storedWhere = "local";
  }

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
    rec.sha256 = provided;
    rec.size = size;
    rec.timing = timing;
    rec.ghostLength = ghostLength;
    rec.name = name;
    rec.createdAt = new Date().toISOString();

    rec.ghostKey = storedWhere === "r2" ? objectKey : null;
    rec.ghostPath = storedWhere === "local" ? localPath : null;
  } else {
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
      ghostKey: storedWhere === "r2" ? objectKey : null,
      ghostPath: storedWhere === "local" ? localPath : null,
      sha256: provided,
      size,
      createdAt: new Date().toISOString()
    });
  }

  saveRecords();

  return {
    ok: true,
    storedAs: storedWhere === "r2" ? objectKey : path.basename(localPath),
    where: storedWhere,
    size
  };
});

// --------------------
// /ghost/bytes (binary)
// Streams from R2 (preferred) or local disk (fallback)
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
      (r.ghostKey || r.ghostPath)
  );

  if (steamid) candidates = candidates.filter((r) => r.driver__steamID64 === steamid);

  if (candidates.length === 0) {
    return reply.code(404).send("ghost not found");
  }

  candidates.sort((a, b) => a.timing - b.timing);
  const best = candidates[0];

  reply.header("Content-Type", "application/octet-stream");

  // Prefer R2 if available
  if (best.ghostKey && R2_ENABLED) {
    try {
      const out = await s3.send(
        new GetObjectCommand({
          Bucket: R2_BUCKET,
          Key: best.ghostKey
        })
      );

      const bodyStream = out.Body;
      const nodeStream =
        bodyStream instanceof Readable ? bodyStream : Readable.fromWeb(bodyStream);

      if (out.ContentLength != null) {
        reply.header("Content-Length", String(out.ContentLength));
      }

      return reply.send(nodeStream);
    } catch (e) {
      req.log.error({ err: e }, "Failed to fetch ghost from R2");
      return reply.code(500).send("failed to fetch ghost");
    }
  }

  // Fallback local
  if (best.ghostPath && fs.existsSync(best.ghostPath)) {
    const buf = fs.readFileSync(best.ghostPath);
    reply.header("Content-Length", String(buf.length));
    return reply.send(buf);
  }

  return reply.code(404).send("ghost not found");
});

// --------------------
// /getRecords (TS-compatible shape)
// --------------------
fastify.get("/getRecords", async (req) => {
  const q = req.query || {};

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

// Make sure Render sees a bound listener
await fastify.listen({ port: PORT, host: HOST });
