// src/store.js
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const RECORDS_PATH = path.join(DATA_DIR, "records.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

// Load on boot
function loadRecords() {
  try {
    if (!fs.existsSync(RECORDS_PATH)) {
      fs.writeFileSync(RECORDS_PATH, "[]", "utf8");
      return [];
    }
    const raw = fs.readFileSync(RECORDS_PATH, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // If JSON is broken, don’t destroy it—rename it for recovery
    try {
      const broken = path.join(DATA_DIR, `records.broken.${Date.now()}.json`);
      fs.renameSync(RECORDS_PATH, broken);
      fs.writeFileSync(RECORDS_PATH, "[]", "utf8");
    } catch {}
    return [];
  }
}

export const records = loadRecords();

// Save helper
export function saveRecords() {
  fs.writeFileSync(RECORDS_PATH, JSON.stringify(records, null, 2), "utf8");
}
