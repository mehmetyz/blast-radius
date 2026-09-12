import { config } from "./config.js";

const BASE = "https://app.ambiguous.ai";

export type ChannelMessage = {
  id: string;
  thread_id: string | null;
  thread_key: string | null;
  content: string;
  deleted_at?: string | null;
};

async function ambiguous<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.ambiguousApiKey) throw new Error("AMBIGUOUS_API_KEY is not set");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.ambiguousApiKey}`,
      "API-Version": "1",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ambiguous ${res.status} ${path.split("/").pop()}: ${text.slice(0, 180)}`);
  }
  return (await res.json()) as T;
}

function channelPath(suffix: string): string {
  if (!config.ambiguousChannelId) throw new Error("AMBIGUOUS_CHANNEL_ID is not set");
  return `/api/channels/${config.ambiguousChannelId}${suffix}`;
}

export async function listMessages(limit = 50): Promise<ChannelMessage[]> {
  const res = await ambiguous<{ data?: ChannelMessage[] }>(channelPath(`/messages?limit=${limit}`));
  return res.data ?? [];
}

export async function findMessageByThreadKey(threadKey: string): Promise<ChannelMessage | undefined> {
  const needle = threadKey.slice(0, 7);
  const msgs = (await listMessages(100)).filter((m) => !m.deleted_at && m.content);
  return (
    msgs.find((m) => m.thread_key === threadKey) ??
    msgs.find((m) => m.content.includes(threadKey) || m.content.includes(`\`${needle}\``))
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
