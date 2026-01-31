Below is a single self-contained Node script that:

- Crawls a site (bounded depth) using `website-scraper`.  
- Collects directories discovered during crawl.  
- Scans common `.env` locations plus `<dir>/.env`.  
- Writes findings to a JSON file and also prints them.

It’s written as JS that runs directly with Node 18+ (ESM syntax). Install deps first:

```bash
npm install website-scraper axios
# or
pnpm add website-scraper axios
```

Run:

```bash
node crawlerEnvScanner.mjs https://example.com 2 results.json
```

- `maxDepth` controls crawl depth (default 2).  
- `results.json` is optional; if omitted, a timestamped file is created in CWD.

