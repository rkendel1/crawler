You won’t get a literal “newest sites” feed out-of-the-box, but you can wire a usable pipeline: Athena query → hosts file → `env-scan-run`. Below is the minimal, end‑to‑end setup.

## 1. Set up Athena on Common Crawl

Common Crawl data is on AWS as a public dataset; you query it via Athena against their URL index.[1]

High-level steps in AWS:

1. Create an S3 bucket for query results, e.g. `s3://my-cc-athena-results/`.  
2. In Athena, set that bucket as the query result location.  
3. Create a database, e.g.:

```sql
CREATE DATABASE IF NOT EXISTS commoncrawl;
```

4. Create an external table over the current URL index.  
   Common Crawl’s docs show the exact DDL for the current “URL Index” table; grab their latest `CREATE EXTERNAL TABLE` statement from the “Get Started” / URL Index section and run it in your `commoncrawl` DB.[1]

You’ll end up with a table (name varies by doc, often `ccindex` or similar) that includes fields like `url`, `host`, `crawl`, `status`, `fetch_time` or similar timestamp.

## 2. Athena query: newest crawl, host list

Adjust the table/column names to match their current URL index schema; conceptually you want:

```sql
-- Example: host list from the newest crawl, limited to N
SELECT DISTINCT host
FROM commoncrawl.ccindex
WHERE crawl = 'CC-MAIN-2026-01'      -- newest crawl ID
  AND status = 200
  AND scheme = 'https'
LIMIT 100000;
```

Notes:

- Use the actual table name from the DDL you copied from Common Crawl docs.[1]
- `crawl = 'CC-MAIN-2026-01'` pins to the newest monthly crawl; update this as new crawls appear.[2][3]
- You can add filters (e.g., `tld = 'com'`) if you want to narrow scope.  

Run the query, then:

- In Athena console, click “Download results” → CSV.  
- Save as `hosts-2026-01.txt`, keep one hostname per line.

## 3. Node batch runner: `env-scan-run.mjs`

Use the JS batch runner tied to your existing `crawlAndScan`:

```js
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
```

This expects your existing `crawlerEnvScanner.mjs` file exactly as we had it earlier.

## 4. Putting it together

1. In your repo, have:

   - `crawlerEnvScanner.mjs` (single-domain crawler + scanner).  
   - `env-scan-run.mjs` (batch runner above).  

2. Install deps:

```bash
npm install website-scraper axios
```

3. From Athena, download your host list and save as `hosts-2026-01.txt`.

4. Run the batch scan:

```bash
node env-scan-run.mjs hosts-2026-01.txt out-2026-01 1
```

- `hosts-2026-01.txt` – output from Athena query (one host per line).  
- `out-2026-01` – directory where JSON results per host + `summary.json` go.  
- Depth `1` keeps crawling shallow and faster.

This is the full, ready-to-run integration loop: newest Common Crawl → hosts file → Node batch scanner, with the “newest” aspect controlled by choosing the latest crawl ID and (optionally) timestamp filters in Athena.[3][2][1]

Sources
[1] Overview - Common Crawl https://commoncrawl.org/overview
[2] All Around The World: The Common Crawl Dataset - watchTowr Labs https://labs.watchtowr.com/all-around-the-world-the-common-crawl-dataset/
[3] Common Crawl - Open Repository of Web Crawl Data https://commoncrawl.org
