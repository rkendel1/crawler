// crawlerEnvScanner.mjs

import scrape from "website-scraper"; // website-scraper usage[web:16][web:43][web:44]
import axios from "axios";            // axios HTTP client[web:36]
import fs from "node:fs";             // Node fs for writing files[web:34][web:37][web:40]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

const CANDIDATE_ENV_PATHS = [
  "/.env",
  "/.env.local",
  "/.env.development",
  "/.env.production",
  "/.env.backup",
  "/.env.bak",
  "/.env.old",
  "/config/.env",
  "/api/.env",
  "/server/.env",
  "/backup/.env",
];

function looksLikeEnv(body) {
  const lines = body.split(/\r?\n/).filter(Boolean);
  const kvLines = lines.filter((line) => /^[A-Z0-9_]+\s*=\s*.+$/.test(line));
  return kvLines.length >= 3;
}

function findSecretKeys(content) {
  const regex = /sk-[a-zA-Z0-9_-]{20,}/gi;
  const lines = content.split(/\r?\n/);
  const matches = [];
  lines.forEach((line, idx) => {
    const hits = [...line.matchAll(regex)];
    if (hits.length > 0) {
      hits.forEach(hit => {
        const snippet = line.slice(Math.max(0, line.indexOf(hit[0]) - 20), line.indexOf(hit[0]) + hit[0].length + 20).trim();
        matches.push({ lineNum: idx + 1, key: hit[0], snippet });
      });
    }
  });
  return matches.length > 0 ? matches.slice(0, 5) : []; // Limit to first 5
}

function normalizeBase(base) {
  if (!base.startsWith("http://") && !base.startsWith("https://")) {
    return "https://" + base.replace(/\/+$/, "");
  }
  return base.replace(/\/+$/, "");
}

function sameOrigin(base, target) {
  try {
    const b = new URL(base);
    const t = new URL(target);
    return b.hostname === t.hostname && b.protocol === t.protocol;
  } catch {
    return false;
  }
}

async function probeUrl(url) {
  try {
    const res = await axios.get(url, {
      timeout: 5000,
      maxRedirects: 3,
      validateStatus: () => true,
      responseType: "text",
    });

    if (res.status !== 200 || typeof res.data !== "string") return null;

    const body = res.data;
    if (body.length > 1_000_000) return null; // ~1 MB cap

    if (!looksLikeEnv(body)) return null;

    const contentLengthHeader = res.headers["content-length"];
    const contentLength = contentLengthHeader
      ? parseInt(contentLengthHeader, 10)
      : null;

    const sample = body.split(/\r?\n/).slice(0, 10).join("\n");

    return {
      url,
      status: res.status,
      contentLength: Number.isNaN(contentLength) ? null : contentLength,
      sample,
    };
  } catch {
    return null;
  }
}

async function scanForEnvAtBase(base) {
  const hits = [];
  const normalized = normalizeBase(base);
  const urls = CANDIDATE_ENV_PATHS.map((p) => normalized + p);

  const concurrency = 5;
  let idx = 0;

  async function worker() {
    while (idx < urls.length) {
      const current = urls[idx++];
      const hit = await probeUrl(current);
      if (hit) hits.push(hit);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return hits;
}

export async function crawlAndScan(baseUrl, maxDepth = 2) {
  const startUrl = normalizeBase(baseUrl);

  const discoveredDirs = new Set();
  discoveredDirs.add(new URL(startUrl).origin + "/");

  // website-scraper plugin to collect directories and scan for sk- secrets[web:43][web:44]
  class CollectDirsAndSecretsPlugin {
    constructor() {
      this.secretHits = [];
      this.envInlineHits = [];
    }

    apply(registerAction) {
      registerAction("onResourceSaved", ({ resource }) => {
        const url = resource.getUrl ? resource.getUrl() : resource.url;
        try {
          const u = new URL(url);
          if (!sameOrigin(startUrl, u.toString())) return;

          let dir;
          if (u.pathname.endsWith("/")) {
            dir = u.pathname;
          } else {
            const lastSlash = u.pathname.lastIndexOf("/");
            dir = lastSlash >= 0 ? u.pathname.slice(0, lastSlash + 1) : "/";
          }
          discoveredDirs.add(u.origin + dir);

          // Scan for sk- secrets if text resource
          if (!resource.binary && typeof resource.content === 'string') {
            const matches = findSecretKeys(resource.content);
            if (matches.length > 0) {
              this.secretHits.push({
                url,
                matches,
                contentLength: resource.content.length,
              });
            }

            // Scan for inline env exposures in JS/HTML
            if (u.pathname.endsWith('.js') || u.pathname.endsWith('.html') || u.pathname.endsWith('.htm')) {
              const content = resource.content;
              const envRegexes = [
                /process\.env\.(\w+)/gi,
                /window\.(\w*Env\w*)/gi,
                /meta\s+name=["']([^"']*env[^"']*)["'][^>]*content=["']([^"']+)["']/gi
              ];
              const inlineMatches = [];
              const lines = content.split(/\r?\n/);
              lines.forEach((line, idx) => {
                envRegexes.forEach(regex => {
                  const hits = [...line.matchAll(regex)];
                  hits.forEach(hit => {
                    const varName = hit[1];
                    const value = hit[3] || null; // For meta, value in group 3
                    const snippet = line.slice(Math.max(0, line.indexOf(hit[0]) - 20), line.indexOf(hit[0]) + hit[0].length + 20).trim();
                    inlineMatches.push({ lineNum: idx + 1, varName, value, snippet, regex: regex.source });
                  });
                });
              });
              if (inlineMatches.length > 0) {
                this.envInlineHits.push({
                  url,
                  matches: inlineMatches.slice(0, 5),
                  contentLength: content.length,
                });
              }
            }
          }
        } catch {
          // ignore malformed URLs or non-text
        }
      });
    }

    getSecretHits() {
      return this.secretHits;
    }

    getEnvInlineHits() {
      return this.envInlineHits;
    }
  }

  // Crawl site (bounded depth) using website-scraper recursive mode[web:16][web:44]
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const mirrorDir = path.join(__dirname, "mirror");

  if (fs.existsSync(mirrorDir)) {
    fs.rmSync(mirrorDir, { recursive: true, force: true });
  }

  const plugin = new CollectDirsAndSecretsPlugin();
  await scrape({
    urls: [startUrl],
    directory: mirrorDir,
    recursive: true,
    maxRecursiveDepth: maxDepth,
    plugins: [plugin],
  });

  fs.rmSync(mirrorDir, { recursive: true, force: true });

  const secretHits = plugin.getSecretHits();

  // 1) scan base-level common .env paths
  const envHits = await scanForEnvAtBase(startUrl);

  // 2) for each discovered directory, try <dir>/.env
  const dirUrls = Array.from(discoveredDirs).map((dir) =>
    dir.endsWith("/") ? dir + ".env" : dir + "/.env"
  );

  const concurrency = 10;
  let idx = 0;

  async function dirWorker() {
    while (idx < dirUrls.length) {
      const current = dirUrls[idx++];
      const hit = await probeUrl(current);
      if (hit) envHits.push(hit);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => dirWorker()));

  // dedupe env hits by URL
  const byUrl = new Map();
  for (const h of envHits) {
    if (!byUrl.has(h.url)) byUrl.set(h.url, h);
  }

  // dedupe secret hits by URL
  const secretByUrl = new Map();
  for (const h of secretHits) {
    if (!secretByUrl.has(h.url)) secretByUrl.set(h.url, h);
  }

  const envInlineHits = plugin.getEnvInlineHits();

  return {
    envHits: [...Array.from(byUrl.values()), ...envInlineHits],
    secretHits: Array.from(secretByUrl.values())
  };
}

// CLI entrypoint: node crawlerEnvScanner.mjs <url> [maxDepth] [outFile]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , target, depthArg, outArg] = process.argv;

  if (!target) {
    console.error(
      "Usage: node crawlerEnvScanner.mjs <url> [maxDepth] [outFile]"
    );
    process.exit(1);
  }

  const maxDepth = depthArg ? parseInt(depthArg, 10) : 2;
  const outFile =
    outArg ||
    path.join(
      process.cwd(),
      `env-scan-${encodeURIComponent(target)}-${Date.now()}.json`
    );

  crawlAndScan(target, maxDepth)
    .then(({ envHits, secretHits }) => {
      if (envHits.length > 0 || secretHits.length > 0) {
        const payload = {
          target,
          maxDepth,
          envFindings: envHits,
          secretFindings: secretHits,
          scannedAt: new Date().toISOString(),
        };

        const json = JSON.stringify(payload, null, 2);
        fs.writeFileSync(outFile, json, "utf8"); // typical fs.writeFileSync pattern[web:34][web:37][web:40]

        console.log(json);
        console.error(`Wrote results to ${outFile}`);
      } else {
        console.log(`No env or sk- findings for ${target}`);
      }
    })
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
