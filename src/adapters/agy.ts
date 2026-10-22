/**
 * Google Antigravity CLI (agy).
 * Store: ~/.gemini/antigravity-cli/conversation_summaries.db and conversations/*.db.
 * Protobuf field numbers verified against the installed agy's embedded descriptors:
 * step.user_input=19, step.planner_response=20; UserInput.items=3 (item.text=1),
 * query=1, user_response=2; PlannerResponse.response=1, modified_response=8,
 * thinking=3, raw_thinking=16, tool_calls=7; ChatToolCall.name=2, arguments_json=3.
 * Only these known fields are decoded; unknown steps are never guessed as prose.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DetectionResult, ExternalSession, SessionDetail } from "../types.ts";
import { emptyFidelity } from "../types.ts";
import type { NativeResumeAction, SessionAdapter } from "./types.ts";
import { openReadOnly } from "../sqlite.ts";
import { cleanText, clip } from "../security.ts";
import { addSearchText, countTools, deriveRepo, extractCommand, parseIso, probePath,
  pushCommand, safeStat, searchTextFrom, titleFromPreview } from "./util.ts";

interface Summary {
  conversation_id: string;
  title: string;
  preview: string;
  last_modified_time: string;
  workspace_uris: string;
}
const COLUMNS = "conversation_id, title, preview, last_modified_time, workspace_uris";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AgyAdapter implements SessionAdapter {
  id = "agy" as const;
  displayName = "Antigravity CLI";
  private readonly root: string;
  private readonly dbPath: string;

  constructor(home: string) {
    this.root = path.join(home, ".gemini", "antigravity-cli");
    this.dbPath = path.join(this.root, "conversation_summaries.db");
  }

  async detect(): Promise<DetectionResult> {
    const base = { harness: this.id, root: this.dbPath, sessionCount: 0 };
    const probe = probePath(this.dbPath);
    if (probe === "missing") return { ...base, status: "path_missing" };
    if (probe === "denied") return { ...base, status: "permission_denied" };
    const db = await openReadOnly(this.dbPath, true);
    if (!db) return { ...base, status: "error", detail: "could not open summary database" };
    try {
      // Probe required columns as well as the table; report schema drift explicitly.
      db.all(`select ${COLUMNS} from conversation_summaries limit 0`);
      const row = db.get<{ n: number }>("select count(*) as n from conversation_summaries");
      return { ...base, status: "available", sessionCount: row?.n ?? 0 };
    } catch (err) {
      return { ...base, status: "unsupported_version", detail: String(err) };
    } finally { db.close(); }
  }

  async listSessions(opts?: { maxSessions?: number }): Promise<ExternalSession[]> {
    const db = await openReadOnly(this.dbPath, true);
    if (!db) {
      if (probePath(this.dbPath) !== "missing") throw new Error("cannot read agy summaries");
      return [];
    }
    try {
      const rows = db.all<Summary>(`select ${COLUMNS} from conversation_summaries
        order by last_modified_time desc limit ?`, [Math.max(0, opts?.maxSessions ?? 2000)]);
      const out: ExternalSession[] = [];
      for (const row of rows) out.push(await this.load(row, false));
      return out;
    } finally { db.close(); }
  }

  async getSession(nativeId: string): Promise<SessionDetail | null> {
    const db = await openReadOnly(this.dbPath, true);
    if (!db) return null;
    try {
      const row = db.get<Summary>(`select ${COLUMNS} from conversation_summaries where conversation_id = ?`, [nativeId]);
      return row ? await this.load(row, true) : null;
    } finally { db.close(); }
  }

  async buildNativeResume(nativeId: string): Promise<NativeResumeAction | null> {
    if (!UUID.test(nativeId)) return null;
    return {
      command: "agy", args: ["--conversation", nativeId],
      verificationBasis: "cli-help", verified: true,
      verificationNote: "flag documented in `agy --help` (--conversation: Resume a previous conversation by ID)",
      requiresConfirmation: true, description: `Resume conversation ${nativeId} with Antigravity CLI`,
    };
  }

  private async load(row: Summary, withMessages: boolean): Promise<SessionDetail> {
    // Never let a source-controlled id escape the conversations directory.
    const file = UUID.test(row.conversation_id)
      ? path.join(this.root, "conversations", `${row.conversation_id}.db`) : null;
    const notes = ["Only user/assistant prose and planner tool calls are decoded; tool results, model, creation time, and file changes are not available."];
    const messages: { role: string; text: string }[] = [];
    const search: string[] = [];
    const names: string[] = [];
    const commands: string[] = [];
    let messageCount = 0;
    let hasReasoning = false;
    let skipped = 0;
    const db = file ? await openReadOnly(file, true) : null;
    if (db) {
      try {
        // Bounded prose scan for indexing; larger bounded scan for context.
        const limit = withMessages ? 4000 : 400;
        const steps = db.all<{ step_format: number; step_payload: Uint8Array }>(
          "select step_format, step_payload from steps order by idx limit ?", [limit + 1]);
        if (steps.length > limit) notes.push(`Transcript scan limited to ${limit} steps.`);
        for (const step of steps.slice(0, limit)) {
          if (step.step_format !== 0) { skipped++; continue; }
          try {
            const fields = decodeFields(step.step_payload);
            const user = fields.get(19)?.[0];
            const assistant = fields.get(20)?.[0];
            let role: string;
            let text: string;
            if (user) {
              const u = decodeFields(user);
              role = "user";
              text = (u.get(3) ?? []).map((item) => stringField(decodeFields(item), 1)).filter(Boolean).join("\n")
                || stringField(u, 1) || stringField(u, 2);
            } else if (assistant) {
              const a = decodeFields(assistant);
              role = "assistant";
              text = stringField(a, 8) || stringField(a, 1);
              hasReasoning ||= Boolean(stringField(a, 3) || stringField(a, 16));
              for (const tool of a.get(7) ?? []) {
                const t = decodeFields(tool);
                const name = cleanText(stringField(t, 2));
                if (!name) continue;
                names.push(name);
                pushCommand(commands, extractCommand(name, stringField(t, 3)));
              }
            } else { skipped++; continue; }
            messageCount++;
            const clean = cleanText(text);
            addSearchText(search, role, clean);
            if (clean && withMessages) messages.push({ role, text: clip(clean, 8000) });
          } catch { skipped++; }
        }
      } catch (err) {
        notes.push(`Transcript unavailable: ${String(err)}`);
      } finally { db.close(); }
    } else notes.push("Transcript database missing or unreadable; summary metadata only.");
    if (skipped) notes.push(`${skipped} unsupported or malformed steps omitted.`);
    let cwd: string | null = null;
    try {
      const uris: unknown = JSON.parse(row.workspace_uris);
      if (Array.isArray(uris)) {
        const uri = uris.find((u) => typeof u === "string" && u.startsWith("file:"));
        if (uri) cwd = fileURLToPath(uri);
      }
    } catch { /* Unavailable or non-local workspace. */ }
    const stats = [this.dbPath, `${this.dbPath}-wal`, ...(file ? [file, `${file}-wal`] : [])]
      .map(safeStat).filter((s) => s !== null);
    const preview = cleanText(row.preview ?? "") || null;
    return {
      uid: `agy:${row.conversation_id}`, harness: this.id, nativeId: row.conversation_id,
      path: file && safeStat(file) ? file : this.dbPath,
      title: titleFromPreview(cleanText(row.title ?? "") || preview, `Antigravity conversation ${row.conversation_id}`),
      createdAt: null, updatedAt: parseIso(row.last_modified_time), cwd, repo: deriveRepo(cwd),
      model: null, messageCount, toolCount: names.length, preview: preview ? clip(preview, 160) : null,
      searchText: searchTextFrom(search) ?? preview,
      fidelity: { ...emptyFidelity(notes), hasToolCalls: names.length > 0, hasReasoning },
      mtimeMs: Math.max(0, ...stats.map((s) => s.mtimeMs)),
      size: stats.reduce((n, s) => n + s.size, 0),
      messages, tools: Array.from(countTools(names), ([name, count]) => ({ name, count })), commands,
    };
  }
}

/** Minimal bounded wire reader: retain length-delimited fields, skip other scalars. */
function decodeFields(bytes: Uint8Array): Map<number, Uint8Array[]> {
  if (!(bytes instanceof Uint8Array) || bytes.length > 8 * 1024 * 1024) throw new Error("invalid payload");
  let pos = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let i = 0; i < 10 && pos < bytes.length; i++) {
      const b = bytes[pos++];
      value |= BigInt(b & 127) << BigInt(i * 7);
      if (b < 128) return value;
    }
    throw new Error("invalid varint");
  };
  const out = new Map<number, Uint8Array[]>();
  while (pos < bytes.length) {
    const key = Number(varint());
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (!Number.isSafeInteger(key) || field < 1 || field > 0x1fffffff) throw new Error("invalid tag");
    if (wire === 0) { varint(); continue; }
    const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - pos) throw new Error("invalid length");
    if (wire === 2) {
      const values = out.get(field) ?? [];
      values.push(bytes.subarray(pos, pos + length));
      out.set(field, values);
    }
    pos += length;
  }
  return out;
}
function stringField(fields: Map<number, Uint8Array[]>, field: number): string {
  const bytes = fields.get(field)?.[0];
  return bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : "";
}
