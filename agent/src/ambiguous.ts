import { config } from "./config.js";

const BASE = "https://app.ambiguous.ai";

export type ChannelMessage = {
  id: string;
  thread_id: string | null;
  thread_key: string | null;
  content: string;
  deleted_at?: string | null;
  poll_id?: string | null;
};

async function ambiguous<T>(path: string, init: RequestInit = {}, key = config.ambiguousApiKey): Promise<T> {
  if (!key) throw new Error("AMBIGUOUS_API_KEY is not set");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      "API-Version": "1",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ambiguous ${res.status} ${path.split("/").pop()}: ${text.slice(0, 180)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function sheetKey(): string {
  return config.ambiguousWorkspaceKey || config.ambiguousApiKey;
}

export function workspaceApiKey(): string {
  return sheetKey();
}

function channelPath(suffix: string): string {
  if (!config.ambiguousChannelId) throw new Error("AMBIGUOUS_CHANNEL_ID is not set");
  return `/api/channels/${config.ambiguousChannelId}${suffix}`;
}

export async function listMessages(
  limit = 50,
  opts: { before?: string; key?: string } = {},
): Promise<ChannelMessage[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.before) params.set("before", opts.before);
  const res = await ambiguous<{ data?: ChannelMessage[] }>(
    channelPath(`/messages?${params}`),
    {},
    opts.key,
  );
  return res.data ?? [];
}

export async function listThreadReplies(
  messageId: string,
  key?: string,
): Promise<ChannelMessage[]> {
  const res = await ambiguous<{ replies?: ChannelMessage[]; data?: ChannelMessage[] }>(
    channelPath(`/messages/${messageId}/thread?limit=100`),
    {},
    key,
  );
  return res.replies ?? res.data ?? [];
}

export async function findMessageByThreadKey(threadKey: string): Promise<ChannelMessage | undefined> {
  const needle = threadKey.slice(0, 7);
  const msgs = (await listMessages(100)).filter((m) => !m.deleted_at && m.content);
  return (
    msgs.find((m) => m.thread_key === threadKey) ??
    msgs.find((m) => m.content.includes(threadKey) || m.content.includes(`\`${needle}\``)) ??
    msgs.find((m) => /^\/blast-radius\s+(active|rootcause)\s+/i.test(m.content) && m.content.includes(needle))
  );
}

export async function updateMessage(messageId: string, content: string) {
  return ambiguous<ChannelMessage>(channelPath(`/messages/${messageId}`), {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
}

export async function postMessage(content: string, threadKey?: string | null, startsNewBlock = false) {
  const body: Record<string, unknown> = {
    content,
    starts_new_block: startsNewBlock,
  };
  if (threadKey) body.thread_key = threadKey;
  return ambiguous<ChannelMessage>(channelPath("/messages"), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteMessages(
  messageIds: string[],
  key?: string,
): Promise<{ deleted?: string[]; rejected?: string[] }> {
  if (!messageIds.length) return { deleted: [] };
  return ambiguous(
    channelPath("/messages/bulk-delete"),
    {
      method: "POST",
      body: JSON.stringify({ message_ids: messageIds.slice(0, 100) }),
    },
    key,
  );
}

export async function deleteMessage(messageId: string, key?: string) {
  return ambiguous(channelPath(`/messages/${messageId}`), { method: "DELETE" }, key);
}

export type WorkspaceUser = {
  id: string;
  display_name: string | null;
  type?: string;
};

export type SheetSummary = {
  id: string;
  title: string;
};

export async function listAgents(): Promise<WorkspaceUser[]> {
  const res = await ambiguous<{ data?: WorkspaceUser[] }>("/api/admin/users?type=agent&limit=100");
  return (res.data ?? []).filter((u) => (u.type ?? "agent") === "agent");
}

export async function provisionAgent(displayName: string): Promise<{
  user: WorkspaceUser;
  apiKey: string;
}> {
  const res = await ambiguous<{ user: WorkspaceUser; api_key: string }>("/api/admin/users/provision-agent", {
    method: "POST",
    body: JSON.stringify({ display_name: displayName, role: "member" }),
  });
  if (!res.user?.id) throw new Error("agent provision returned no user");
  return { user: res.user, apiKey: res.api_key };
}

export async function addChannelMember(userId: string) {
  return ambiguous(channelPath("/members"), {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function listSheets(): Promise<SheetSummary[]> {
  const res = await ambiguous<{ data?: SheetSummary[] }>("/api/sheets");
  return res.data ?? [];
}

export async function createSheet(title: string): Promise<{ id: string; title?: string }> {
  return ambiguous<{ id: string; title?: string }>("/api/sheets", {
    method: "POST",
    body: JSON.stringify({ title, visibility: "workspace" }),
  });
}

export async function appendSheetValues(sheetId: string, values: string[][], range = "A1") {
  return ambiguous(
    `/api/sheets/${sheetId}/values/append`,
    {
      method: "POST",
      body: JSON.stringify({ range, values }),
    },
    sheetKey(),
  );
}

export async function getSheetRange(sheetId: string, spec = "A1:Z50"): Promise<string[][]> {
  const res = await ambiguous<{ data?: { sheets?: { rows?: Record<string, string>[] }[] }; values?: string[][] }>(
    `/api/sheets/${sheetId}`,
    {},
    sheetKey(),
  );
  const rows = res.data?.sheets?.[0]?.rows;
  if (rows?.length) {
    const cols = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    return rows.map((row) => cols.slice(0, 16).map((c) => row[c] ?? ""));
  }
  return res.values ?? [];
}

function cellsFrom(values: string[][], startRow = 0) {
  const cells: { row: number; column: string; value: string }[] = [];
  const width = Math.max(16, ...values.map((r) => r.length));
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < width; c++) {
      cells.push({
        row: startRow + r,
        column: String.fromCharCode(65 + c),
        value: values[r][c] ?? "",
      });
    }
  }
  return cells;
}

export async function patchSheetCells(
  sheetId: string,
  cells: { row: number; column: string; value: string }[],
) {
  return ambiguous(
    `/api/sheets/${sheetId}/cells`,
    {
      method: "PATCH",
      body: JSON.stringify({ cells }),
    },
    sheetKey(),
  );
}

export async function updateSheetValues(sheetId: string, values: string[][], _range = "A1") {
  return patchSheetCells(sheetId, cellsFrom(values));
}

export type DocumentSummary = {
  id: string;
  title?: string;
};

export async function listDocuments(): Promise<DocumentSummary[]> {
  const res = await ambiguous<{ data?: DocumentSummary[] }>("/api/documents");
  return res.data ?? [];
}

export async function deleteDocument(id: string): Promise<void> {
  await ambiguous(`/api/documents/${id}`, { method: "DELETE" }, sheetKey());
}

export async function createDocument(title: string, markdown: string): Promise<{ id: string }> {
  return ambiguous<{ id: string }>("/api/documents", {
    method: "POST",
    body: JSON.stringify({ type: "doc", title, content: markdown, visibility: "workspace" }),
  });
}

export async function updateDocument(id: string, markdown: string, title?: string) {
  const body: Record<string, unknown> = { content: markdown };
  if (title) body.title = title;
  try {
    return await ambiguous<{ id: string }>(`/api/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } catch {
    return ambiguous<{ id: string }>(
      `/api/documents/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
      sheetKey(),
    );
  }
}

export async function renameDocument(id: string, title: string) {
  try {
    return await ambiguous<{ id: string }>(`/api/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  } catch {
    return ambiguous<{ id: string }>(
      `/api/documents/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title }),
      },
      sheetKey(),
    );
  }
}

export async function replyInThread(threadId: string, content: string, startsNewBlock = false) {
  return ambiguous<ChannelMessage>(channelPath("/messages"), {
    method: "POST",
    body: JSON.stringify({
      content,
      thread_id: threadId,
      starts_new_block: startsNewBlock,
    }),
  });
}

// Reply inside the thread of a specific message (e.g. a human's command) —
// not in the alert's own thread.
export async function replyInMessageThread(msg: ChannelMessage, content: string) {
  return replyInThread(msg.thread_id ?? msg.id, content);
}

export const YES_OPTION = "Yes, roll back";
export const NO_OPTION = "No, keep it";

export type Poll = {
  id: string;
  message_id: string | null;
  question: string;
  closed_at: string | null;
  created_at: string;
  options: { id: string; text: string }[];
};

export type PollResults = {
  poll_id: string;
  closed_at: string | null;
  total_votes: number;
  options: { id: string; text: string; vote_count: number }[];
};

export async function createPoll(question: string, options: string[], closeAt: Date): Promise<Poll> {
  if (!config.ambiguousChannelId) throw new Error("AMBIGUOUS_CHANNEL_ID is not set");
  const res = await ambiguous<Poll & { poll?: Poll }>("/api/polls", {
    method: "POST",
    body: JSON.stringify({
      channel_id: config.ambiguousChannelId,
      question,
      options,
      close_at: closeAt.toISOString(),
      anonymous: false,
      multi_vote: false,
    }),
  });
  const poll = res.id ? res : res.poll;
  if (!poll?.id) throw new Error("poll create returned no id");
  return poll;
}

export async function getPoll(pollId: string): Promise<Poll> {
  const res = await ambiguous<Poll & { poll?: Poll }>(`/api/polls/${pollId}`);
  const poll = res.id ? res : res.poll;
  if (!poll?.id) throw new Error("poll get returned no id");
  return poll;
}

export async function getPollResults(pollId: string): Promise<PollResults> {
  const res = await ambiguous<PollResults & { results?: PollResults }>(`/api/polls/${pollId}/results`);
  if (res.options) return res;
  if (res.results?.options) return res.results;
  return { poll_id: pollId, closed_at: null, total_votes: 0, options: [] };
}

export async function closePoll(pollId: string): Promise<Poll> {
  return ambiguous<Poll>(`/api/polls/${pollId}/close`, { method: "POST" });
}

export async function getPollByMessage(messageId: string, key?: string): Promise<Poll | null> {
  try {
    const res = await ambiguous<Poll & { poll?: Poll }>(`/api/polls/by-message/${messageId}`, {}, key);
    const poll = res.id ? res : res.poll;
    return poll?.id ? poll : null;
  } catch {
    return null;
  }
}

export async function deletePoll(pollId: string, key?: string) {
  return ambiguous(`/api/polls/${pollId}`, { method: "DELETE" }, key);
}

export async function createTask(input: {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  due_date?: string;
}): Promise<{ id: string }> {
  const res = await ambiguous<{ task?: { id: string }; id?: string }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      priority: input.priority ?? "high",
      due_date: input.due_date,
      status: "todo",
    }),
  });
  const id = res.task?.id ?? res.id;
  if (!id) throw new Error("task create returned no id");
  return { id };
}

export type TaskSummary = {
  id: string;
  title?: string;
};

export async function listTasks(
  opts: { q?: string; limit?: number; cursor?: string; key?: string } = {},
): Promise<TaskSummary[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.q) params.set("q", opts.q);
  if (opts.cursor) params.set("cursor", opts.cursor);
  const res = await ambiguous<{ data?: TaskSummary[]; tasks?: TaskSummary[] }>(
    `/api/tasks?${params}`,
    {},
    opts.key,
  );
  return res.data ?? res.tasks ?? [];
}

export async function deleteTask(id: string, key?: string) {
  return ambiguous(`/api/tasks/${id}`, { method: "DELETE" }, key);
}

export async function permanentlyDeleteTask(id: string, key?: string) {
  return ambiguous(`/api/tasks/${id}/permanent`, { method: "DELETE" }, key);
}
