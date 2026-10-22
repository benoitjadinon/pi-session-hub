import fs from "node:fs";
import path from "node:path";
import { openIndexDb } from "../../src/sqlite.ts";

// Synthetic wire-format fixtures, not copied personal conversations.
export function varint(n) {
  const out = [];
  do { out.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128); } while (n);
  return Buffer.from(out);
}
export function field(n, value) {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([varint(n * 8 + 2), varint(bytes.length), bytes]);
}
export const AGY_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export async function buildAgy(home, project = "/srv/work/acme-api") {
  const root = path.join(home, ".gemini", "antigravity-cli");
  fs.mkdirSync(path.join(root, "conversations"), { recursive: true });
  const summaries = await openIndexDb(path.join(root, "conversation_summaries.db"));
  summaries.run(`create table conversation_summaries (conversation_id text primary key,
    title text, preview text, last_modified_time text, workspace_uris text)`);
  summaries.run("insert into conversation_summaries values (?, ?, ?, ?, ?)", [
    AGY_ID, "Fake Antigravity Session", "fake agy: improve cache eviction",
    "2026-01-01 00:00:00.123456789+00:00", JSON.stringify([`file://${project}`]),
  ]);
  summaries.close();
  const db = await openIndexDb(path.join(root, "conversations", `${AGY_ID}.db`));
  db.run("create table steps (idx integer primary key, step_format integer, step_payload blob)");
  db.run("insert into steps values (0, 0, ?)", [field(19, field(3, field(1, "fake agy: improve cache eviction")))]);
  db.run("insert into steps values (1, 0, ?)", [field(20, Buffer.concat([
    field(1, "fake agy reply: implemented least recently used eviction"),
    field(3, "synthetic reasoning"),
    field(7, Buffer.concat([field(2, "bash"), field(3, '{"command":"npm test"}')])),
  ]))]);
  db.close();
  return root;
}
