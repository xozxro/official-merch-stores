#!/usr/bin/env node
// Rebuilds data/stores.json, data/stores.csv and README.md from Dropify's public API.
// Usage: node scripts/generate.mjs [--check]   (--check prints the summary and writes nothing)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API = process.env.DROPIFY_API || 'https://production.dropify.cloud';
const SITE = 'https://dropify.cloud';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const CATEGORY_LABELS = {
  music: 'Music',
  kpop: 'K-pop',
  streetwear: 'Streetwear',
  anime: 'Anime',
  gaming: 'Gaming',
  tech: 'Tech',
  food: 'Food',
  beauty: 'Beauty',
  gear: 'Gear',
  sneakers: 'Sneakers',
  sports: 'Sports',
  vinyl: 'Vinyl',
  cars: 'Cars',
  watches: 'Watches',
  toys: 'Toys',
  'art-prints': 'Art prints',
  books: 'Books',
  outdoor: 'Outdoor',
  other: 'Other',
};

// Country a store is read from -> region label.
const REGION_BY_COUNTRY = {
  US: 'United States',
  GB: 'United Kingdom',
  UK: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  JP: 'Japan',
  KR: 'South Korea',
};
const EU = new Set(['DE', 'FR', 'IT', 'ES', 'NL', 'IE', 'SE', 'NO', 'DK', 'FI', 'BE', 'AT', 'PL', 'PT', 'EU']);
const REGION_BY_TLD = { kr: 'South Korea', jp: 'Japan', uk: 'United Kingdom', au: 'Australia', ca: 'Canada' };

// Multi-brand shops that are retailers even when the API does not flag them.
const RETAILER_HOSTS = /(^|\.)(hottopic|boxlunch|emp-online|emp\.co\.uk|impericon|rockabilia)\./i;

async function getJson(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

function regionOf(source, url) {
  const cc = String(source.proxyCountryCode || '').toUpperCase();
  if (REGION_BY_COUNTRY[cc]) return REGION_BY_COUNTRY[cc];
  if (EU.has(cc)) return 'Europe';
  try {
    const tld = new URL(url).hostname.split('.').pop();
    if (REGION_BY_TLD[tld]) return REGION_BY_TLD[tld];
  } catch { /* fall through */ }
  return 'Global';
}

function cleanUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function hostOf(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

function sortKey(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function esc(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/([|*_`<>[\]])/g, '\\$1');
}

function csvCell(v) {
  const t = String(v ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function csv(data) {
  const rows = [['artist', 'slug', 'category', 'type', 'store_name', 'store_url', 'region', 'alerts_url']];
  for (const b of data) {
    for (const s of b.officialStores) rows.push([b.name, b.slug, b.category, 'official', s.name, s.url, s.region, b.alerts]);
    for (const r of b.retailers) rows.push([b.name, b.slug, b.category, 'retailer', r.name, r.url, '', b.alerts]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

// Largest categories first, "other" last.
function categoryGroups(list) {
  const groups = new Map();
  for (const b of list) {
    if (!groups.has(b.category)) groups.set(b.category, []);
    groups.get(b.category).push(b);
  }
  return [...groups.entries()].sort((a, b) => (a[0] === 'other') - (b[0] === 'other') || b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

async function build() {
  const [brands, sources] = await Promise.all([
    getJson(`${API}/api/landing/brands`),
    getJson(`${API}/api/all-sources`),
  ]);
  if (!Array.isArray(brands) || brands.length < 100 || !Array.isArray(sources)) {
    throw new Error('Unexpected API shape; refusing to overwrite the data.');
  }
  const detail = new Map(sources.map((s) => [s._id, s]));

  const out = [];
  for (const b of brands) {
    if (!b.slug || !b.name) continue;
    const official = [];
    const retailers = [];
    const seen = new Set();
    for (const s of b.sources || []) {
      const d = detail.get(s._id);
      if (!d || d.isPaused || d.isHidden) continue;
      const url = cleanUrl(d.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const isRetailer = Boolean(s.retailer || d.retailer || RETAILER_HOSTS.test(new URL(url).hostname + '.'));
      if (isRetailer) {
        retailers.push({ name: s.name.replace(/\s+(US|EU|UK|CA|AU)$/, ''), url });
      } else {
        official.push({ name: s.name, url, region: regionOf(s, url) });
      }
    }
    if (!official.length && !retailers.length) continue;
    out.push({
      name: b.name,
      slug: b.slug,
      category: b.category || 'other',
      alerts: `${SITE}/brand/${b.slug}`,
      officialStores: official,
      retailers,
    });
  }
  out.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)) || a.slug.localeCompare(b.slug));
  return out;
}

function storeCell(stores) {
  return stores.map((s) => `[${esc(hostOf(s.url))}](${s.url})`).join('<br>');
}

function regionCell(stores) {
  return stores.map((s) => s.region).join('<br>');
}

function retailerCell(list) {
  return list.map((r) => `[${esc(r.name)}](${r.url})`).join('<br>') || '';
}

function readme(data) {
  const withStore = data.filter((b) => b.officialStores.length);
  const retailerOnly = data.filter((b) => !b.officialStores.length);
  const year = new Date().getUTCFullYear();

  const lines = [];
  const p = (s = '') => lines.push(s);

  p('# Official Merch Stores');
  p();
  p('Official Merch Stores is an open dataset of artist and brand merch shops. It lists hundreds of official stores across music, K-pop, streetwear, anime and more. Each entry links to the store and a restock alerts page. Data comes as JSON and CSV, free to reuse under CC0.');
  p();
  p('**Restock alerts:** get them for any store at [dropify.cloud](https://dropify.cloud). Seamless shopping. Instant product alerts.');
  p();
  p('[Get alerts](#how-to-get-restock-alerts-for-any-artist) | [By category](#browse-by-category) | [A to Z](#official-merch-stores-a-to-z) | [Retailers](#sold-at-retailers) | [Data](#data-dictionary) | [FAQ](#faq) | [Cite](#how-to-cite)');
  p();
  p('## How to get restock alerts for any artist');
  p();
  p('1. **Dropify app.** Open [app.dropify.cloud](https://app.dropify.cloud), follow an artist and get an alert when sold-out merch is back. Every brand has a free store, and you won\'t be asked for a card. All Access adds every other store.');
  p('2. **Discord bot.** [Add the Dropify bot](https://dropify.cloud/discord-bot) to your server, run `/dropify setup` and pick a channel and up to three brands, then add more with `/dropify add`, up to 25. It posts drops, restocks, price drops and sell-outs.');
  p('3. **Artist page.** Every row below links to that artist\'s Dropify page, where you can turn on alerts.');
  p();
  p('Alerts arrive in seconds with the product, its price and a link to the official store.');
  p();
  p('## Browse by category');
  p();
  for (const [cat, list] of categoryGroups(withStore)) {
    p(`### ${CATEGORY_LABELS[cat] || 'Other'}`);
    p();
    p('| Artist | Official store | Alerts |');
    p('| --- | --- | --- |');
    for (const b of list) {
      p(`| ${esc(b.name)} | ${storeCell(b.officialStores)} | [Restock alerts](${b.alerts}) |`);
    }
    p();
  }
  p('## Official merch stores A to Z');
  p();
  p('Retailers like Hot Topic carry merch but are not the artist\'s own store. They sit in their own column.');
  p();
  p('| Artist | Category | Official store | Region | Retailer | Alerts |');
  p('| --- | --- | --- | --- | --- | --- |');
  for (const b of withStore) {
    p(`| ${esc(b.name)} | ${CATEGORY_LABELS[b.category] || 'Other'} | ${storeCell(b.officialStores)} | ${regionCell(b.officialStores)} | ${retailerCell(b.retailers)} | [Restock alerts](${b.alerts}) |`);
  }
  p();
  if (retailerOnly.length) {
    p('## Sold at retailers');
    p();
    p('These brands are carried by retailers. Open the alerts page for stores and drops.');
    p();
    p('| Brand | Category | Retailer | Alerts |');
    p('| --- | --- | --- | --- |');
    for (const b of retailerOnly) {
      p(`| ${esc(b.name)} | ${CATEGORY_LABELS[b.category] || 'Other'} | ${retailerCell(b.retailers)} | [Restock alerts](${b.alerts}) |`);
    }
    p();
  }
  p('## Data dictionary');
  p();
  p('Files: `data/stores.json` and `data/stores.csv`. Both hold the same stores.');
  p();
  p('| Field | Type | Meaning |');
  p('| --- | --- | --- |');
  p('| `name` / `artist` | string | Artist or brand name |');
  p('| `slug` | string | URL key, matches the Dropify brand page |');
  p('| `category` | string | One of: ' + [...new Set(data.map((b) => b.category))].sort().map((c) => `\`${c}\``).join(', ') + ' |');
  p('| `alerts` / `alerts_url` | URL | Dropify restock alerts page for the brand |');
  p('| `officialStores[]` | array | Official stores: `name`, `url`, `region` |');
  p('| `retailers[]` | array | Retailers carrying the brand: `name`, `url` |');
  p('| `region` | string | Store region, such as United States or Europe |');
  p('| `type` (CSV) | string | `official` or `retailer` |');
  p('| `store_name`, `store_url` (CSV) | string, URL | One store per row |');
  p();
  p('## FAQ');
  p();
  p('### How do I know when merch restocks?');
  p();
  p('Follow the artist on [Dropify](https://app.dropify.cloud). It compares each official store with its last read. When a sold-out product is back, you get an alert with the product, its price and the store link. Find the artist in the table above and open their alerts page.');
  p();
  p('### Is there a Discord bot for merch restocks?');
  p();
  p('Yes. The [Dropify bot](https://dropify.cloud/discord-bot) posts new drops, restocks, price drops and sell-outs in your server. Run `/dropify setup` to pick the channel, up to three brands and which alerts post. Add more with `/dropify add`, up to 25. It never mentions @everyone, a role or a member.');
  p();
  p('### How do I find an artist\'s official merch store?');
  p();
  p('Search this page for the artist\'s name. The Official store column links straight to it. You can also open the artist\'s official website and follow its shop link. Dropify sells nothing, so every link goes to the store itself.');
  p();
  p('### How do I avoid fake merch stores?');
  p();
  p('Start from this list or the artist\'s own website and social profiles. Be wary of shops reached through ads, where the domain has the artist\'s name plus extra words or an odd ending. Heavy discounts on sold-out items are a red flag. Pay by card or PayPal so you can dispute a charge.');
  p();
  p('## How to cite');
  p();
  p('Dropify. *Official Merch Stores* (dataset). GitHub. https://github.com/xozxro/official-merch-stores');
  p();
  p('```bibtex');
  p('@misc{dropify_official_merch_stores,');
  p('  title        = {Official Merch Stores},');
  p('  author       = {Dropify},');
  p(`  year         = {${year}},`);
  p('  howpublished = {\\url{https://github.com/xozxro/official-merch-stores}}');
  p('}');
  p('```');
  p();
  p('GitHub shows a **Cite this repository** button from `CITATION.cff`.');
  p();
  p('## License');
  p();
  p('Data: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Use it freely, no credit needed.');
  p();
  p('Code in `scripts/`: MIT.');
  p();
  p('## Contributing');
  p();
  p('Missing a store? [Open an issue](https://github.com/xozxro/official-merch-stores/issues/new?template=store-request.yml) with the artist and the official store link.');
  p();
  p('---');
  p();
  p('Maintained by [Dropify](https://dropify.cloud). Rebuild with `node scripts/generate.mjs`.');
  p();
  return lines.join('\n');
}

const data = await build();
const updated = new Date().toISOString().slice(0, 10);
const official = data.reduce((n, b) => n + b.officialStores.length, 0);
const retailerLinks = data.reduce((n, b) => n + b.retailers.length, 0);
console.log(`brands=${data.length} withOfficialStore=${data.filter((b) => b.officialStores.length).length} retailerOnly=${data.filter((b) => !b.officialStores.length).length} officialLinks=${official} retailerLinks=${retailerLinks}`);

if (!CHECK) {
  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await writeFile(path.join(ROOT, 'data', 'stores.json'), JSON.stringify({ updated, source: `${API}/api/landing/brands`, brands: data }, null, 2) + '\n');
  await writeFile(path.join(ROOT, 'data', 'stores.csv'), csv(data));
  await writeFile(path.join(ROOT, 'README.md'), readme(data));
}
