import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const arg1 = process.argv[2];
  const tlds = ['com', 'app', 'dev', 'org', 'net', 'io'];
  const limit = arg1 !== undefined && !isNaN(parseInt(arg1, 10)) ? parseInt(arg1, 10) : 100;
  const domains = new Set();

  const perTldLimit = limit;
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15'
  ];

  for (const querySuffix of tlds) {
    const jitter = 2000 + Math.random() * 4000; // 2-6s jitter for variability
    await new Promise(resolve => setTimeout(resolve, jitter + 15000)); // 15s base + jitter

    let query;
    if (querySuffix === 'com') {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      query = `%.${querySuffix} AND entry_timestamp > "${thirtyDaysAgo}"`;
    } else {
      query = `%.${querySuffix}`;
    }
    const url = `https://crt.sh/?q=${encodeURIComponent(query)}&output=json`;
  
    console.error(`Fetching recent domains ending in .${querySuffix} from crt.sh...`);

    let retryCount = 0;
    const maxRetries = 5;
    let response;
    while (retryCount < maxRetries) {
      const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
      try {
        response = await axios.get(url, {
          timeout: 120000, // 120s timeout
          headers: {
            'User-Agent': randomUA,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://crt.sh/'
          }
        });
        break; // Success, exit retry loop
      } catch (err) {
        const status = err.response?.status;
        const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
        if (status === 502 || status === 503 || status === 429 || isTimeout) {
          retryCount++;
          const errorType = isTimeout ? 'timeout' : `${status} error`;
          console.error(`Retry ${retryCount}/${maxRetries} for .${querySuffix} after ${errorType}`);
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, retryCount) * 5000)); // Exponential backoff with 5s base
        } else {
          throw err; // Non-rate-limit error, fail
        }
      }
    }

    if (!response) {
      console.error(`CT pull error for .${querySuffix}: Max retries exceeded`);
      continue;
    }

    const certs = response.data;
    // Sort by entry_timestamp descending for recency
    const sortedCerts = certs.sort((a, b) => new Date(b.entry_timestamp) - new Date(a.entry_timestamp));
    
    let tldCount = 0;
    for (const cert of sortedCerts) {
      const name = cert.name_value.toLowerCase().trim();
      if (name.endsWith(`.${querySuffix}`)) {
        domains.add(name);
        tldCount++;
      }
      if (tldCount >= perTldLimit) break;
    }
  }

  const hosts = Array.from(domains);
  const outFile = path.join(process.cwd(), 'hosts.txt');
  fs.writeFileSync(outFile, hosts.join('\n') + '\n', 'utf8');
  console.error(`Wrote ${hosts.length} unique domains across TLDs to ${outFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('CT pull error:', err.message);
    process.exit(1);
  });
}