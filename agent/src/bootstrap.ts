import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addChannelMember,
  appendSheetValues,
  createSheet,
  listAgents,
  listSheets,
  provisionAgent,
} from "./ambiguous.js";
import { config } from "./config.js";
import { LEDGER_HEADER, LEDGER_TITLE, LEDGER_TITLES } from "./copy.js";

const AGENT_NAME = "Blast Radius";

function upsertEnv(updates: Record<string, string>) {
  const path = resolve(".env");
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  for (const [key, value] of Object.entries(updates)) {
    if (!value) continue;
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, line);
    else text += `${line}\n`;
  }
  writeFileSync(path, text);
}

async function ensureAgent() {
  const existing = (await listAgents()).find(
    (u) => (u.display_name ?? "").toLowerCase() === AGENT_NAME.toLowerCase(),
  );
  if (existing) {
    upsertEnv({ AMBIGUOUS_AGENT_ID: existing.id });
    try {
      await addChannelMember(existing.id);
    } catch {
      // already a member
    }
    console.log(`agent ready ${existing.id}`);
    return existing;
  }

  const { user, apiKey } = await provisionAgent(AGENT_NAME);
  upsertEnv({
    AMBIGUOUS_AGENT_ID: user.id,
    AMBIGUOUS_AGENT_API_KEY: apiKey,
  });
  try {
    await addChannelMember(user.id);
  } catch {
    // already a member
  }
  console.log(`agent created ${user.id}`);
  return user;
}

async function ensureLedger() {
  if (config.ambiguousSheetId) {
    console.log(`ledger already configured ${config.ambiguousSheetId}`);
    return config.ambiguousSheetId;
  }
  const existing = (await listSheets()).find((s) => LEDGER_TITLES.includes(s.title));
  if (existing) {
    upsertEnv({ AMBIGUOUS_SHEET_ID: existing.id });
    console.log(`ledger reused ${existing.id}`);
    return existing.id;
  }
  const sheet = await createSheet(LEDGER_TITLE);
  await appendSheetValues(sheet.id, [LEDGER_HEADER], "A1");
  upsertEnv({ AMBIGUOUS_SHEET_ID: sheet.id });
  console.log(`ledger created ${sheet.id}`);
  return sheet.id;
}

const agent = await ensureAgent();
const sheetId = await ensureLedger();
console.log(`ok agent=${agent.id} ledger=${sheetId}`);
