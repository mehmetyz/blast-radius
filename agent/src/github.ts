import { config } from "./config.js";

const API = "https://api.github.com";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function repo(): { owner: string; name: string } {
  const raw = config.githubRepo || "mehmetyz/blast-radius-demo";
  const [owner, name] = raw.split("/");
  if (!owner || !name) throw new Error("GITHUB_REPO must be owner/name");
  return { owner, name };
}

export async function github<T>(
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN is not set");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.githubToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status >= 500 && attempt < 3) {
    await sleep(300 * 2 ** attempt);
    return github<T>(path, init, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status} ${path}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type PrFile = { filename: string; status: string; patch?: string };

export async function listPrFiles(pr: number): Promise<PrFile[]> {
  const { owner, name } = repo();
  return github<PrFile[]>(`/repos/${owner}/${name}/pulls/${pr}/files?per_page=100`);
}

export async function githubCompare(base: string, head: string) {
  const { owner, name } = repo();
  return github<{
    html_url: string;
    commits: { sha: string; commit: { message: string; author: { name: string } }; author: { login: string } | null }[];
    files: { filename: string; status: string; patch?: string }[];
  }>(`/repos/${owner}/${name}/compare/${base}...${head}`);
}

export async function commentOnPr(pr: number, body: string): Promise<void> {
  const { owner, name } = repo();
  const comments = await github<{ id: number; body: string }[]>(
    `/repos/${owner}/${name}/issues/${pr}/comments?per_page=50`,
  );
  const existing = comments.find((c) => c.body.startsWith("## Blast Radius INSIGHT"));
  if (existing) {
    await github(`/repos/${owner}/${name}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    return;
  }
  await github(`/repos/${owner}/${name}/issues/${pr}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}
