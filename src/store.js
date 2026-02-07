import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadRecords() {
  try {
    if (!fs.existsSync(RECORDS_FILE)) {
      fs.writeFileSync(RECORDS_FILE, "[]", "utf8");
      return [];
    }

    const raw = fs.readFileSync(RECORDS_FILE, "utf8").trim();
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;

    // If someone accidentally wrote an object, reset safely
    return [];
  } catch {
    // If JSON is corrupted, do not crash server — start empty
    return [];
  }
}

export const records = loadRecords();

export function saveRecords() {
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2), "utf8");
}
