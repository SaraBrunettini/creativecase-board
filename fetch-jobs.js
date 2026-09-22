#!/usr/bin/env node
/**
 * Reads every company's job feed and writes jobs.json for the site.
 * Runs once a day in GitHub Actions. No API keys, no accounts, no cost.
 *
 * Local:  node fetch-jobs.js
 */

const fs = require('fs');

/* Companies publish these feeds openly so their careers page can display
   them. We read the same feed their own website does. */
const ATS = {
  greenhouse: {
    url: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    rows: d => (d.jobs || []).map(j => ({
      title: j.title,
      location: j.location && j.location.name,
      url: j.absolute_url,
      posted: j.updated_at || j.first_published,
    })),
  },
  lever: {
    url: s => `https://api.lever.co/v0/postings/${s}?mode=json`,
    rows: d => (Array.isArray(d) ? d : []).map(j => ({
      title: j.text,
      location: j.categories && j.categories.location,
      url: j.hostedUrl,
      posted: j.createdAt && new Date(j.createdAt).toISOString(),
    })),
  },
  ashby: {
    url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    rows: d => (d.jobs || []).map(j => ({
      title: j.title,
      location: j.location,
      url: j.jobUrl || j.applyUrl,
      posted: j.publishedAt,
      remote: j.isRemote,
    })),
  },
};

/* Which roles belong on a creative board, and what discipline each is.
   First match wins, so order matters. */
const DISCIPLINES = [
  ['Research',   /\b(ux research|user research|design research|researcher)\b/i],
  ['Content',    /\b(content design|ux writ|content strateg|copywriter)\b/i],
  ['Motion',     /\b(motion|animator|animation|3d artist)\b/i],
  ['Brand',      /\b(brand|graphic|visual identity|communications design)\b/i],
  ['Leadership', /\b(head of design|design director|creative director|art director|design manager|design lead|director of design)\b/i],
  ['Design ops', /\b(design ops|design operations|design producer)\b/i],
  ['Product',    /\b(product design|ux|ui|interaction design|design system|design engineer|design technologist)\b/i],
  ['Design',     /\b(design|designer|creative|illustrat)\b/i],
];

/* Words that look creative but aren't these jobs. */
const NOT_CREATIVE = new RegExp([
  /* not these jobs at all */
  'sales|account executive|recruiter|talent partner|solutions architect',
  'mechanical|electrical|civil|hardware|chip|silicon|wms|warehouse',
  /* engineering roles that only mention design in passing */
  'engineering manager',
  '(ios|android|backend|back-end|frontend|front-end|full ?stack|software|data|platform|infrastructure|security|qa|test|mobile|web|systems?)\\s+engineer',
  /* research that isn't design research */
  'security research|market research',
  /* commercial roles that borrow the words brand and creative */
  'partnerships?|enablement|business development|transformation owner|event manager',
].join('|'), 'i');

function discipline(title) {
  if (!title || NOT_CREATIVE.test(title)) return null;
  for (const [name, re] of DISCIPLINES) if (re.test(title)) return name;
  return null;
}

/* Europe only. */
const EUROPE = /\b(uk|united kingdom|england|scotland|wales|london|manchester|bristol|edinburgh|glasgow|cambridge|oxford|leeds|brighton|reading|dublin|ireland|berlin|munich|münchen|hamburg|frankfurt|cologne|germany|deutschland|paris|france|lyon|amsterdam|rotterdam|utrecht|netherlands|madrid|barcelona|spain|lisbon|porto|portugal|milan|rome|italy|stockholm|sweden|copenhagen|denmark|oslo|norway|helsinki|finland|warsaw|krak|poland|prague|czech|zurich|zürich|geneva|switzerland|vienna|austria|brussels|belgium|europe|emea)\b/i;

const isEurope = (loc, remote) =>
  !loc ? false : EUROPE.test(loc) || (remote && /remote/i.test(loc));

/* Guess the board name from the company name. */
function slugsFor(name) {
  const base = name.toLowerCase().trim()
    .replace(/\b(ltd|limited|inc|llc|gmbh|bv|ab|oy|sa|plc|group|the)\b/g, '')
    .replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ').trim();
  return [...new Set([base.replace(/ /g, ''), base.replace(/ /g, '-')])].filter(Boolean);
}

async function fetchFeed(slug, ats) {
  try {
    const res = await fetch(ATS[ats].url(slug), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const rows = ATS[ats].rows(await res.json()).filter(r => r.title && r.url);
    return rows.length ? { slug, ats, rows } : null;
  } catch { return null; }
}

async function pool(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

const prettyName = slug =>
  slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

(async () => {
  if (typeof fetch !== 'function') {
    console.error('Needs Node 18+.'); process.exit(1);
  }

  const names = fs.readFileSync(`${__dirname}/companies.txt`, 'utf8')
    .split('\n').map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));

  /* A confirmed board is remembered, so we stop guessing after the first
     success and the run gets faster over time. */
  let known = {};
  try { known = JSON.parse(fs.readFileSync(`${__dirname}/companies.json`, 'utf8')); } catch {}

  const targets = [];
  for (const name of names) {
    const hit = known[name];
    if (hit) { targets.push({ name, slug: hit.slug, ats: hit.ats }); continue; }
    for (const slug of slugsFor(name))
      for (const ats of Object.keys(ATS)) targets.push({ name, slug, ats });
  }

  console.log(`${names.length} companies → ${targets.length} feed requests`);
  const feeds = (await pool(targets, 20, t =>
    fetchFeed(t.slug, t.ats).then(r => r && { ...r, name: t.name })
  )).filter(Boolean);

  /* Keep the richest feed per company. */
  const best = new Map();
  for (const f of feeds) {
    const prev = best.get(f.name);
    if (!prev || f.rows.length > prev.rows.length) best.set(f.name, f);
  }

  const registry = {}, jobs = [];
  for (const [name, f] of best) {
    registry[name] = { slug: f.slug, ats: f.ats, seen: new Date().toISOString().slice(0, 10) };
    for (const r of f.rows) {
      const disc = discipline(r.title);
      if (!disc) continue;
      if (!isEurope(r.location, r.remote)) continue;
      jobs.push({
        title: r.title,
        company: name,
        location: r.location || 'Not stated',
        discipline: disc,
        url: r.url,
        posted: r.posted ? String(r.posted).slice(0, 10) : null,
        remote: !!r.remote || /remote/i.test(r.location || ''),
      });
    }
  }

  /* The same role can appear twice under different guessed slugs. */
  const seenUrl = new Set();
  const unique = jobs.filter(j => seenUrl.has(j.url) ? false : (seenUrl.add(j.url), true));
  unique.sort((a, b) => String(b.posted || '').localeCompare(String(a.posted || '')));
  jobs.length = 0; jobs.push(...unique);


  const out = {
    updated: new Date().toISOString(),
    companies: Object.keys(registry).length,
    count: jobs.length,
    jobs,
  };

  fs.writeFileSync(`${__dirname}/jobs.json`, JSON.stringify(out, null, 1));
  fs.writeFileSync(`${__dirname}/companies.json`, JSON.stringify(registry, null, 1));

  const byDisc = {};
  jobs.forEach(j => { byDisc[j.discipline] = (byDisc[j.discipline] || 0) + 1; });

  console.log(`\n${best.size}/${names.length} boards live (${Math.round(best.size / names.length * 100)}%)`);
  console.log(`${jobs.length} creative roles in Europe\n`);
  Object.entries(byDisc).sort((a, b) => b[1] - a[1])
    .forEach(([d, n]) => console.log(`  ${d.padEnd(12)} ${n}`));
  console.log('\nWrote jobs.json');
})();
