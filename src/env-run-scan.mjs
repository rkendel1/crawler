// env-scan-run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as dns } from "node:dns";
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

  function isCleanUrl(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.includes("go to") || trimmed.includes("see") || trimmed.includes("*") || trimmed.includes("(c)")) {
      return false;
    }
    // Regex for clean domain/host: subdomains + TLD, optional port
    const domainRegex = /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?$/;
    return domainRegex.test(trimmed);
  }

  const lines = fs.readFileSync(hostsFile, "utf8").split(/\r?\n/);
  const candidates = lines
    .map((l) => l.trim())
    .filter(isCleanUrl)
    .map((line) => {
      let target = line.startsWith("http://") || line.startsWith("https://")
        ? line
        : `https://${line}`;
      try {
        new URL(target);
        return target;
      } catch (err) {
        console.warn(`Skipping invalid URL: ${line}`);
        return null;
      }
    })
    .filter(Boolean);

  // Async DNS validation
  const dnsPromises = candidates.map(async (target) => {
    try {
      const url = new URL(target);
      const hostname = url.hostname;
      await dns.lookup(hostname);
      return target;
    } catch (err) {
      if (err.code === 'ENOTFOUND') {
        console.warn(`Skipping unresolvable domain: ${target}`);
      }
      return null;
    }
  });

  const hosts = (await Promise.allSettled(dnsPromises))
    .map((result) => result.status === 'fulfilled' ? result.value : null)
    .filter(Boolean);

  // Write cleaned hosts back to file for self-cleaning
  const cleanedLines = hosts.map(h => h.replace(/^https?:\/\//, '')).join('\n') + '\n';
  fs.writeFileSync(hostsFile, cleanedLines, "utf8");
  console.log(`Cleaned and updated ${hostsFile} with ${hosts.length} clean URLs`);

  const concurrency = 5;
  let idx = 0;
  const results = [];

  async function worker(id) {
    while (idx < hosts.length) {
      const host = hosts[idx++];
      const target = host;

      try {
        const findings = await crawlAndScan(target, maxDepth);
        const totalFindings = (findings.envHits?.length || 0) + (findings.secretHits?.length || 0);
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
          findingsCount: totalFindings
        });
        console.error(
          `[worker ${id}] scanned ${target} -> ${totalFindings} findings`
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
