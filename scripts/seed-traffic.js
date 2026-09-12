const DEMO_URL = process.env.DEMO_URL ?? "http://127.0.0.1:3000/api/chat";
const n = Number(process.env.COUNT ?? 20);

async function main() {
  let ok = 0;
  let failed = 0;
  let ingested = 0;
  for (let i = 0; i < n; i++) {
    const res = await fetch(DEMO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: `Order #${1000 + i} ships tomorrow. Write a one-sentence customer reply.`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ingest_ok) ingested += 1;
    if (!res.ok) {
      failed += 1;
      console.error(`request ${i + 1} failed: ${res.status}`, data.error ?? "");
      continue;
    }
    ok += 1;
    console.log(`${i + 1}/${n} sha=${data.sha?.slice(0, 7) ?? "?"} ingest=${data.ingest_ok ? "ok" : "miss"}`);
  }
  console.log(`sent ${ok}/${n} ok, ${failed} errors, ingest_ok ${ingested} → ${DEMO_URL}`);
  if (ingested < 20) process.exit(1);
}

main();
