const DEMO_URL = process.env.DEMO_URL;
if (!DEMO_URL) {
  console.error("DEMO_URL is required");
  process.exit(1);
}

async function main() {
  const n = Number(process.env.COUNT ?? 20);
  for (let i = 0; i < n; i++) {
    const res = await fetch(DEMO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: `seed ${i + 1}` }),
    });
    if (!res.ok) {
      console.error(`request ${i + 1} failed: ${res.status}`);
      process.exit(1);
    }
  }
  console.log(`sent ${n} requests to ${DEMO_URL}`);
}

main();
