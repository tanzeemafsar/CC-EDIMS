'use strict';
// =============================================================================
// EDIMS — routes/scraper.js
// Hardware specification scraper
// cheerio + native fetch (Node 20) + custom rate queue + sharp webp
// =============================================================================

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const express = require('express');
const cheerio = require('cheerio');
const sharp   = require('sharp');

const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'hardware');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ── Rate-limited queue: 1 request / 2 s (avoids ESM p-queue) ────────────────
class RateLimitedQueue {
  constructor(intervalMs = 2000) {
    this.intervalMs = intervalMs;
    this.queue      = [];
    this.running    = false;
    this.lastRun    = 0;
  }
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (!this.running) this._tick();
    });
  }
  _tick() {
    if (!this.queue.length) { this.running = false; return; }
    this.running = true;
    const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastRun));
    setTimeout(async () => {
      const { fn, resolve, reject } = this.queue.shift();
      this.lastRun = Date.now();
      try   { resolve(await fn()); }
      catch (err) { reject(err); }
      this._tick();
    }, wait);
  }
  get size() { return this.queue.length; }
}
const scraperQueue = new RateLimitedQueue(2000);

// ── SSRF guard ───────────────────────────────────────────────────────────────
function isSafeExternalUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '::1') return false;
  if (/^127\./.test(h))  return false;
  if (/^10\./.test(h))   return false;
  if (/^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^169\.254\./.test(h)) return false;
  if (/^fc00:/i.test(h) || /^fe80:/i.test(h)) return false;
  return true;
}

// ── Fetch with 10-second AbortController timeout ─────────────────────────────
async function fetchWithTimeout(url, ms = 10000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal:  ctrl.signal,
      headers: {
        'User-Agent': 'EDIMS-AssetScraper/1.0 (internal)',
        'Accept':     'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Download + convert image to .webp via sharp ───────────────────────────────
async function downloadAndConvertImage(imageUrl, label) {
  if (!isSafeExternalUrl(imageUrl)) return null;
  let res;
  try {
    res = await fetchWithTimeout(imageUrl, 10000);
    if (!res.ok) return null;
  } catch { return null; }
  const ct = res.headers.get('content-type') || '';
  if (!/image\/(jpeg|png|webp|gif|avif)/.test(ct)) return null;
  try {
    const buf      = Buffer.from(await res.arrayBuffer());
    const hash     = crypto.createHash('sha256').update(imageUrl).digest('hex').slice(0, 12);
    const safeLbl  = (label || 'hw').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40);
    const filename = `${safeLbl}-${hash}.webp`;
    const filePath = path.join(IMAGES_DIR, filename);
    await sharp(buf)
      .resize({ width: 800, withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toFile(filePath);
    return { filename, filePath, webUrl: `/images/hardware/${filename}`, sizeBytes: fs.statSync(filePath).size };
  } catch { return null; }
}

// ── HTML spec extractor ───────────────────────────────────────────────────────
function extractSpecsFromHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  const title = (
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').text()
  ).trim().replace(/\s+/g, ' ');

  const description = (
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') || ''
  ).trim().replace(/\s+/g, ' ').slice(0, 500);

  const canonical =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') || sourceUrl;

  let rawImageUrl =
    $('meta[property="og:image"]').attr('content') ||
    $('main img, article img, .product img').first().attr('src') || null;
  if (rawImageUrl && rawImageUrl.startsWith('/')) {
    try { rawImageUrl = new URL(sourceUrl).origin + rawImageUrl; } catch { rawImageUrl = null; }
  }
  if (rawImageUrl && !rawImageUrl.startsWith('http')) rawImageUrl = null;

  const specs = {};
  const kwRe  = /\b(cpu|processor|gpu|ram|memory|storage|ssd|display|screen|resolution|battery|weight|os|wifi|bluetooth|ports|usb|thunderbolt|chip|core|ghz|mhz|gb|tb|watt|inch)\b/i;

  $('table').each((_, table) => {
    let matched = 0;
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('th, td');
      if (cells.length >= 2) {
        const key = $(cells[0]).text().trim().replace(/\s+/g, ' ');
        const val = $(cells[1]).text().trim().replace(/\s+/g, ' ');
        if (key && val && kwRe.test(key + ' ' + val)) { specs[key] = val; matched++; }
      }
    });
    if (matched > 5) return false;
  });

  if (!Object.keys(specs).length) {
    $('dl').each((_, dl) => {
      const dts = $(dl).find('dt'), dds = $(dl).find('dd');
      dts.each((i, dt) => {
        const k = $(dt).text().trim(), v = $(dds.eq(i)).text().trim();
        if (k && v && kwRe.test(k + ' ' + v)) specs[k] = v;
      });
    });
  }

  return { title, description, canonical, rawImageUrl, specs };
}

// =============================================================================
// ROUTE FACTORY
// =============================================================================
module.exports = function scraperRoutes(can) {
  const router = express.Router();

  // GET /api/hardware/scrape?url=https://...
  router.get('/scrape', can('assets:write'), async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query parameter is required.' });
    if (!isSafeExternalUrl(url))
      return res.status(400).json({ error: 'URL disallowed. Only public HTTPS URLs are permitted.' });
    if (scraperQueue.size > 10)
      return res.status(429).json({ error: 'Scraper queue is full. Try again shortly.' });

    try {
      const result = await scraperQueue.enqueue(async () => {
        let fetchRes;
        try {
          fetchRes = await fetchWithTimeout(url, 10000);
        } catch (err) {
          throw new Error(err.name === 'AbortError' ? 'Request timed out after 10 seconds.' : `Fetch failed: ${err.message}`);
        }
        if (!fetchRes.ok) throw new Error(`Remote server returned HTTP ${fetchRes.status}`);
        const ct = fetchRes.headers.get('content-type') || '';
        if (!ct.includes('text/html')) throw new Error(`Response is not HTML (${ct})`);

        const html    = await fetchRes.text();
        const scraped = extractSpecsFromHtml(html, url);

        let imageResult = null;
        if (scraped.rawImageUrl && isSafeExternalUrl(scraped.rawImageUrl)) {
          const slug = scraped.title.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase().slice(0, 40);
          imageResult = await downloadAndConvertImage(scraped.rawImageUrl, slug);
        }

        return {
          title:       scraped.title,
          description: scraped.description,
          canonical:   scraped.canonical,
          specs:       scraped.specs,
          specsCount:  Object.keys(scraped.specs).length,
          image:       imageResult
            ? { url: imageResult.webUrl, filename: imageResult.filename, sizeBytes: imageResult.sizeBytes, format: 'webp' }
            : null,
          sourceUrl:  url,
          scrapedAt:  new Date().toISOString(),
        };
      });

      return res.json({ success: true, data: result });
    } catch (err) {
      console.error('[SCRAPER] Error:', url, '—', err.message);
      return res.status(502).json({ error: `Scrape failed: ${err.message}`, sourceUrl: url });
    }
  });

  // GET /api/hardware/queue-status
  router.get('/queue-status', can('assets:read'), (req, res) => {
    res.json({ queuedJobs: scraperQueue.size, isProcessing: scraperQueue.running, rateLimitMs: 2000 });
  });

  // GET /api/hardware/images
  router.get('/images', can('assets:read'), (req, res) => {
    try {
      const files = fs.readdirSync(IMAGES_DIR)
        .filter(f => f.endsWith('.webp'))
        .map(f => {
          const stat = fs.statSync(path.join(IMAGES_DIR, f));
          return { filename: f, webUrl: `/images/hardware/${f}`, sizeBytes: stat.size, createdAt: stat.birthtime.toISOString() };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json({ images: files, count: files.length });
    } catch { res.status(500).json({ error: 'Failed to list images.' }); }
  });

  // DELETE /api/hardware/images/:filename
  router.delete('/images/:filename', can('assets:write'), (req, res) => {
    const { filename } = req.params;
    if (!/^[a-z0-9][a-z0-9\-_.]{0,80}\.webp$/i.test(filename))
      return res.status(400).json({ error: 'Invalid filename.' });
    const filePath = path.join(IMAGES_DIR, filename);
    if (!filePath.startsWith(IMAGES_DIR + path.sep))
      return res.status(400).json({ error: 'Path traversal detected.' });
    try {
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image not found.' });
      fs.unlinkSync(filePath);
      return res.json({ success: true, deleted: filename });
    } catch { return res.status(500).json({ error: 'Failed to delete image.' }); }
  });

  return router;
};
