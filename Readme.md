# Env Web Scanner with Certificate Transparency Logs

Detect exposed .env files on newly issued domains using Certificate Transparency (CT) logs for near-real-time discovery (🔥 underrated).

## Why CT Logs?
- **Near-real-time**: Catch domains as certs are issued, including phishing, throwaway infra, new projects.
- **Zero crawling required**: Public logs provide fresh domains without scraping.
- **Powerful for security**: Focus on live infra, not historical crawls.

**Tools**:
- crt.sh API: Primary source for recent certs.
- Example: `curl "https://crt.sh/?q=%.com&output=json" | jq -r '.[].name_value'`

You won’t get a literal “newest sites” feed, but wire a usable pipeline: CT pull → hosts file → `env-scan-run`.

## 1. CT Pull: New Domains via crt.sh

The `athena-pull.mjs` script (renamed conceptually for CT) fetches recent domains from crt.sh.

**Prerequisites**:
- Node.js with axios (installed via `npm install`).

**Usage**:
```bash
node src/athena-pull.mjs [tld] [limit]
```
- No args: Fetches top 100000 unique .com domains from recent certs.
- `[tld]` (e.g., 'dev'): Custom TLD suffix (e.g., %.dev).
- `[limit]` (e.g., 100): Max domains (default 100000).
- Outputs `hosts.txt` (one domain per line) in project root. Includes subdomains/wildcards from cert SANs/CN.

Notes:
- Returns newest certs first; top results are recent issuances.
- Rate limits: Script includes timeout/UA; for heavy use, add delays.
- Domains are lowercase, unique, filtered non-empty.

Chain with batch scan:
```bash
node src/athena-pull.mjs 100000 && node src/env-scan-run.mjs hosts.txt scan-results 1
```

## 2. Node Batch Runner: `env-scan-run.mjs`

Use the JS batch runner tied to your existing `crawlAndScan`:

```js
// env-scan-run.mjs (as before)
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
```

This expects your existing `crawlerEnvScanner.mjs` file.

## 3. Putting it Together

1. In your repo:
   - `athena-pull.mjs` (CT domain fetcher).
   - `env-scan-run.mjs` (batch runner above).
   - `crawlerEnvScanner.mjs` (single-domain crawler + scanner).

2. Install deps:
```bash
npm install axios website-scraper
```

3. Run the batch scan:
```bash
node src/athena-pull.mjs  # Generates hosts.txt with 100000 .com domains
node src/env-scan-run.mjs hosts.txt out-results 1
```
- `hosts.txt` – output from CT pull.
- `out-results` – directory for JSON results per host + `summary.json`.
- Depth `1` for shallow, fast crawling.

This is the full pipeline: CT logs → hosts file → Node batch scanner, focusing on newly issued domains for .env exposure detection.

Sources:
- crt.sh: Certificate Transparency Search
- Certificate Transparency Logs: Google Argon, Facebook Nimbus (alternative sources for advanced setups).