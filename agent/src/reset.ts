import { db } from "./db.js";
import { config } from "./config.js";
import {
  deleteDocument,
  deleteMessage,
  deleteMessages,
  deletePoll,
  deleteTask,
  getPollByMessage,
  getSheetRange,
  listDocuments,
  listMessages,
  listTasks,
  listThreadReplies,
  patchSheetCells,
  permanentlyDeleteTask,
  renameDocument,
  workspaceApiKey,
} from "./ambiguous.js";
import { LEDGER_HEADER, LEDGER_TITLE } from "./copy.js";

const LOOKS_LIKE_POLL = /\bPoll:|Vote in the poll/i;
const WATCH_TASK = /\bWatch\b|\bno rollback\b|Blast Radius/i;

function keys(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of [workspaceApiKey(), config.ambiguousApiKey]) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

async function listAllMessages(key: string) {
  const all: Awaited<ReturnType<typeof listMessages>> = [];
  const seen = new Set<string>();
  let before: string | undefined;
  for (let i = 0; i < 40; i++) {
    const page = await listMessages(100, { before, key });
    const fresh = page.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return !m.deleted_at;
    });
    all.push(...fresh);
    if (page.length < 100) break;
    before = page[page.length - 1]?.id;
    if (!before) break;
  }
  return all;
}

async function collectChannel(key: string) {
  const roots = await listAllMessages(key);
  const byId = new Map(roots.map((m) => [m.id, m]));
  for (const root of roots) {
    try {
      const replies = await listThreadReplies(root.id, key);
      for (const reply of replies) {
        if (!reply.deleted_at && !byId.has(reply.id)) byId.set(reply.id, reply);
      }
    } catch {
      // not a thread parent
    }
  }
  return [...byId.values()];
}

async function wipePolls(msgs: Awaited<ReturnType<typeof listMessages>>, key: string) {
  let n = 0;
  for (const msg of msgs) {
    const pollId = msg.poll_id;
    if (!pollId && !LOOKS_LIKE_POLL.test(msg.content ?? "")) continue;
    const poll = pollId ? { id: pollId } : await getPollByMessage(msg.id, key);
    if (!poll?.id) continue;
    try {
      await deletePoll(poll.id, key);
      n += 1;
      console.log(`poll deleted ${poll.id}`);
    } catch (err) {
      console.error(`poll skip ${poll.id}`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`polls deleted ${n}`);
}

async function wipeChannel() {
  const adminKeys = keys();
  if (!adminKeys.length) {
    console.log("no ambiguous key");
    return;
  }
  for (const key of adminKeys) {
    for (let i = 0; i < 20; i++) {
      const msgs = await collectChannel(key);
      if (!msgs.length) {
        console.log("channel empty");
        return;
      }
      await wipePolls(msgs, key);
      const ids = msgs.map((m) => m.id);
      const out = await deleteMessages(ids, key);
      const deleted = out.deleted?.length ?? 0;
      const rejected = out.rejected ?? [];
      console.log(`channel deleted ${deleted} rejected ${rejected.length}`);
      for (const id of rejected) {
        try {
          await deleteMessage(id, key);
        } catch {
          // system / other-author leftover
        }
      }
      if (deleted === 0 && rejected.length === msgs.length) break;
    }
  }
}

async function wipeTasks(knownIds: string[]) {
  const found: { id: string; title?: string }[] = knownIds.map((id) => ({ id }));
  for (const key of keys()) {
    for (const q of ["Watch", "no rollback", "Blast Radius"]) {
      try {
        found.push(...(await listTasks({ q, limit: 100, key })));
      } catch (err) {
        console.error(`tasks list skip ${q}`, err instanceof Error ? err.message : err);
      }
    }
  }
  const seen = new Set<string>();
  let n = 0;
  for (const task of found) {
    if (!task.id || seen.has(task.id)) continue;
    if (task.title && !WATCH_TASK.test(task.title)) continue;
    seen.add(task.id);
    for (const key of keys()) {
      try {
        await deleteTask(task.id, key);
        try {
          await permanentlyDeleteTask(task.id, key);
        } catch {
          // trash is enough
        }
        n += 1;
        console.log(`task deleted ${task.title ?? task.id}`);
        break;
      } catch {
        // try the other key
      }
    }
  }
  console.log(`tasks deleted ${n}`);
}

async function wipeSheet() {
  if (!config.ambiguousSheetId) {
    console.log("no sheet id");
    return;
  }
  await renameDocument(config.ambiguousSheetId, LEDGER_TITLE);
  let existing: string[][] = [];
  try {
    existing = await getSheetRange(config.ambiguousSheetId, "A1:P200");
  } catch {
    existing = [];
  }
  const blank = Math.max(existing.length, 2);
  const cells: { row: number; column: string; value: string }[] = [];
  for (let r = 0; r < blank; r++) {
    for (let c = 0; c < LEDGER_HEADER.length; c++) {
      cells.push({
        row: r,
        column: String.fromCharCode(65 + c),
        value: r === 0 ? (LEDGER_HEADER[c] ?? "") : "",
      });
    }
  }
  await patchSheetCells(config.ambiguousSheetId, cells);
  console.log(`sheet reset rows=${blank}`);
}

async function wipeDocs() {
  const docs = await listDocuments();
  let n = 0;
  for (const d of docs) {
    const title = d.title ?? "";
    if (!/postmortem|post mortem|blast radius/i.test(title)) continue;
    if (title === LEDGER_TITLE) continue;
    try {
      await deleteDocument(d.id);
      n += 1;
      console.log(`doc deleted ${title}`);
    } catch (err) {
      console.error(`doc skip ${d.id}`, err);
    }
  }
  console.log(`docs deleted ${n}`);
}

function knownTaskIds(): string[] {
  return (db.prepare(`SELECT task_id FROM actions WHERE task_id IS NOT NULL`).all() as { task_id: string }[])
    .map((r) => r.task_id)
    .filter(Boolean);
}

function wipeSqlite() {
  db.exec(`
    DELETE FROM telemetry;
    DELETE FROM evaluations;
    DELETE FROM suspects;
    DELETE FROM remediations;
    DELETE FROM actions;
    DELETE FROM pending_reverts;
    DELETE FROM processed_events;
    DELETE FROM predictions;
    DELETE FROM pull_requests;
    DELETE FROM deploys;
    DELETE FROM rollback_intents;
    DELETE FROM commit_analysis;
  `);
  console.log("sqlite wiped");
}

const taskIds = knownTaskIds();
await wipeTasks(taskIds);
wipeSqlite();
await wipeChannel();
await wipeSheet();
await wipeDocs();
console.log("reset done");
