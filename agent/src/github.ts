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

export async function listPrAuthors(pr: number): Promise<string[]> {
  const { owner, name } = repo();
  const commits = await github<{ author: { login: string } | null; commit: { author: { name: string } } }[]>(
    `/repos/${owner}/${name}/pulls/${pr}/commits?per_page=100`,
  );
  const seen = new Set<string>();
  for (const c of commits) {
    const login = c.author?.login ?? c.commit.author.name;
    if (login) seen.add(login);
  }
  return [...seen];
}

export async function commitFiles(
  sha: string,
): Promise<{ filename: string; status: string; patch?: string }[]> {
  const { owner, name } = repo();
  const res = await github<{ files?: { filename: string; status: string; patch?: string }[] }>(
    `/repos/${owner}/${name}/commits/${sha}`,
  );
  return res.files ?? [];
}

export async function githubCompare(base: string, head: string) {
  const { owner, name } = repo();
  return github<{
    html_url: string;
    commits: { sha: string; commit: { message: string; author: { name: string } }; author: { login: string } | null }[];
    files: { filename: string; status: string; patch?: string }[];
  }>(`/repos/${owner}/${name}/compare/${base}...${head}`);
}

export type LinkedPr = {
  number: number;
  title: string;
  html_url: string;
  author: string;
  head: string;
  base: string;
};

export async function getPull(pr: number): Promise<LinkedPr> {
  const { owner, name } = repo();
  const p = await github<{
    number: number;
    title: string;
    html_url: string;
    user: { login: string } | null;
    head: { ref: string };
    base: { ref: string };
  }>(`/repos/${owner}/${name}/pulls/${pr}`);
  return {
    number: p.number,
    title: p.title,
    html_url: p.html_url,
    author: p.user?.login ?? "unknown",
    head: p.head.ref,
    base: p.base.ref,
  };
}

export async function pullsForCommit(sha: string): Promise<LinkedPr[]> {
  const { owner, name } = repo();
  const pulls = await github<
    {
      number: number;
      title: string;
      html_url: string;
      user: { login: string } | null;
      head: { ref: string };
      base: { ref: string };
    }[]
  >(`/repos/${owner}/${name}/commits/${sha}/pulls`);
  return pulls.map((p) => ({
    number: p.number,
    title: p.title,
    html_url: p.html_url,
    author: p.user?.login ?? "unknown",
    head: p.head.ref,
    base: p.base.ref,
  }));
}

export async function commentOnPr(pr: number, body: string): Promise<void> {
  const { owner, name } = repo();
  const comments = await github<{ id: number; body: string }[]>(
    `/repos/${owner}/${name}/issues/${pr}/comments?per_page=50`,
  );
  const existing = comments.find(
    (c) =>
      c.body.startsWith("/blast-radius insight") ||
      c.body.startsWith("## Blast Radius INSIGHT") ||
      c.body.includes("**Cost estimate**") ||
      c.body.includes("**INSIGHT**"),
  );
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

export async function revertDeploy(badSha: string, previousSha: string): Promise<string> {
  const { owner, name } = repo();
  const repoInfo = await github<{ default_branch: string }>(`/repos/${owner}/${name}`);
  const branch = repoInfo.default_branch;
  const ref = await github<{ object: { sha: string } }>(`/repos/${owner}/${name}/git/ref/heads/${branch}`);
  const head = ref.object.sha;

  const reach = await github<{ status: string }>(
    `/repos/${owner}/${name}/compare/${badSha}...${head}`,
  );
  if (reach.status === "diverged" || reach.status === "behind") {
    throw new Error(`${badSha.slice(0, 7)} is not on ${branch}; not touching production`);
  }
  if (reach.status === "ahead") {
    throw new Error(
      `${badSha.slice(0, 7)} is not the tip of ${branch}; later commits exist, not rewriting history`,
    );
  }

  const parent = await github<{ tree: { sha: string } }>(`/repos/${owner}/${name}/git/commits/${previousSha}`);
  const commit = await github<{ sha: string }>(`/repos/${owner}/${name}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `Revert deploy ${badSha.slice(0, 7)}\n\nThis reverts commit ${badSha}.`,
      tree: parent.tree.sha,
      parents: [head],
    }),
  });
  await github(`/repos/${owner}/${name}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
  return commit.sha;
}
