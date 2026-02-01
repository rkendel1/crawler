// env-scan-run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crawlAndScan } from "./crawlerEnvScanner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const [, , hostsFile, outDirArg, depthArg] = process.argv;

  if (!hostsFile) {
    console.error("Usage: node env-scan-run.mjs <hostsFile> [outDir] [maxDepth]");
    process.exit(1);
  }

  const outDir = outDirArg || path.join(process.cwd(), "scan-results");
  const maxDepth = depthArg ? parseInt(depthArg, 10) : 1;

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const hosts = fs
    .readFileSync(hostsFile, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const concurrency = 5;
  let idx = 0;
  const results = [];

  async function worker(id) {
    while (idx < hosts.length) {
      const host = hosts[idx++];
      const target =
        host.startsWith("http://") || host.startsWith("https://")
          ? host
          : `https://${host}`;

      try {
        const findings = await crawlAndScan(target, maxDepth);
        const payload = {
          target,
          maxDepth,
          findings,
          scannedAt: new Date().toISOString()
        };

        const file = path.join(
          outDir,
          `env-scan-${encodeURIComponent(host)}-${Date.now()}.json`
        );
        fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");

        results.push({
          target,
          success: true,
          findingsCount: findings.length
        });
        console.error(
          `[worker ${id}] scanned ${target} -> ${findings.length} findings`
        );
      } catch (err) {
        results.push({
          target,
          success: false,
          error: err instanceof Error ? err.message : String(err)
        });
        console.error(`[worker ${id}] error on ${target}:`, err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => worker(i + 1))
  );

  const summaryFile = path.join(outDir, "summary.json");
  fs.writeFileSync(
    summaryFile,
    JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2),
    "utf8"
  );

  console.log(`Wrote summary to ${summaryFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
