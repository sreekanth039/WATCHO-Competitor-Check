#!/usr/bin/env node

const ref = process.argv[2];

if (!ref) {
  console.error("Usage: node scripts/testRef.js <WATCH_REFERENCE>");
  process.exit(1);
}

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { buildComparison } = require("../server");

async function main() {
  const payload = await buildComparison(ref, true);
  const lines = [];

  lines.push(`Ref: ${payload.ref}`);
  lines.push(`Last checked: ${payload.searchedAt}`);
  lines.push("");
  lines.push(
    `WATCHO: ${payload.watcho.found ? `${payload.watcho.currency || "GBP"} ${payload.watcho.price}` : payload.watcho.reason || "Not found"}`
  );
  lines.push(`WATCHO URL: ${payload.watcho.url || "-"}`);
  lines.push(`WATCHO source: ${payload.watcho.priceSource || "-"}`);
  lines.push("");

  for (const competitor of payload.competitors) {
    lines.push(`${competitor.name}:`);
    lines.push(`  found: ${competitor.found}`);
    lines.push(`  status: ${competitor.status || (competitor.found ? "Found" : "Not found")}`);
    lines.push(`  price: ${competitor.price !== null ? `${competitor.currency || "GBP"} ${competitor.price}` : "-"}`);
    lines.push(`  url: ${competitor.url || "-"}`);
    lines.push(`  reason: ${competitor.reason || "-"}`);
    lines.push(`  extraction source: ${competitor.priceSource || "-"}`);
    lines.push("");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
