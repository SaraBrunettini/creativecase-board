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
      type: j.categories && j.categories.commitment,
      remote: j.workplaceType === 'remote',
    })),
  },
  ashby: {
    url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    rows: d => (d.jobs || []).map(j => ({
      title: j.title,
      location: j.location,
      url: j.jobUrl || j.applyUrl,
      posted: j.publishedAt,
      type: j.employmentType,
      remote: j.isRemote,
    })),
  },
};

/* What counts as a creative role at all. */
const CREATIVE = /(\bdesign|\bcreative|\billustrat|\bbrand\b|\bgraphic|\bux\b|\bui\b|\buser experience|\buser interface|\bmotion|\banimat|\bcopywriter|\bart director|\buser research|\btypograph|\bvisual)/i;

/* Titles that use those words but are not these jobs. */
const NOT_CREATIVE = new RegExp([
  /* different profession entirely */
  'sales|account executive|recruiter|talent partner|solutions architect|solutions manager',
  'mechanical|electrical|civil|hardware|chip|silicon|wms|warehouse|architectural',
  /* engineering roles that only mention design in passing */
  'engineering manager',
  '(ios|android|backend|back-end|frontend|front-end|full[- ]?stack|software|data|platform|infrastructure|security|qa|test|mobile|web|systems?)[- ]?\\s*engineer',
  /* research that is not design research */
  'security research|market research',
  /* commercial roles that borrow the words brand and creative */
  'partnerships?|enablement|business development|transformation owner|event manager',
  'creative strateg|performance creative|forward deployed',
].join('|'), 'i');

/* Which bucket a role belongs in. First match wins, so order matters:
   seniority beats craft, and the narrow crafts are tested before the wide
   ones. Anything creative that fits none of them lands in Other. */
const DISCIPLINES = [
  ['Leadership',   /\b(head of (design|creative|brand|ux|product)|(design|creative|art|brand) director|director,? of (product |global )?(design|ux|creative|brand)|(vp|vice president),? (of )?(design|creative|ux)|design manager|design lead|creative lead|director,? ux|director ux design)\b/i],
  ['Research',     /\b(ux research|uxr|user research|design research|user experience research|researcher)\b/i],
  ['Content',      /\b(content design|content strateg|ux writ|ux copy|copywriter|content lead)\b/i],
  ['Motion',       /(\bmotion|\banimator|\banimation|\b3d )/i],
  ['Design ops',   /\b(design ops|design operations|design program|design producer|creative operations|production design)/i],
  ['Brand',        /(\bbrand|\bgraphic design|\bvisual identity|\bvisual design|\bcommunications design|\bpackaging|\bmarketing design|\billustrat)/i],
  ['Product & UX', /(\bproduct design|\bproduct experience design|\bux\b|\bui\b|\buser experience|\buser interface|\binteraction design|\bdesign system|\bdesign engineer|\bdesign technologist|\bdigital design)/i],
];

function discipline(title) {
  if (!title || !CREATIVE.test(title) || NOT_CREATIVE.test(title)) return null;
  for (const [name, re] of DISCIPLINES) if (re.test(title)) return name;
  return 'Other';
}

/* Employment type. Lever and Ashby publish it; Greenhouse does not, so for
   those it is read off the title, defaulting to full-time. */
const TYPE_WORDS = [
  ['Internship', /\b(intern|internship|working student|werkstudent|placement|apprentice|graduate scheme|praktikum|stage)\b/i],
  ['Contract',   /\b(contract|contractor|freelance|fixed[- ]term|\bftc\b|maternity cover|interim|temporary|temp\b)\b/i],
  ['Part-time',  /\b(part[- ]time|teilzeit|0\.[1-9] fte|\d0% fte)\b/i],
];

function employmentType(raw, title) {
  const r = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  if (r) {
    if (r.startsWith('intern')) return 'Internship';
    if (r.startsWith('parttime')) return 'Part-time';
    if (r.startsWith('fulltime')) return 'Full-time';
    if (r.startsWith('contract') || r.startsWith('temporary')) return 'Contract';
  }
  for (const [name, re] of TYPE_WORDS) if (re.test(title || '')) return name;
  return 'Full-time';
}

const isRemote = (loc, flag) => !!flag || /\bremote\b|\bwork from home\b/i.test(loc || '');

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

  console.log(`${names.length} companies -> ${targets.length} feed requests`);
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
  let scanned = 0;
  for (const [name, f] of best) {
    registry[name] = { slug: f.slug, ats: f.ats, seen: new Date().toISOString().slice(0, 10) };
    scanned += f.rows.length;
    for (const r of f.rows) {
      const disc = discipline(r.title);
      if (!disc) continue;
      jobs.push({
        title: r.title.trim(),
        company: name,
        location: (r.location || 'Not stated').trim(),
        discipline: disc,
        type: employmentType(r.type, r.title),
        url: r.url,
        posted: r.posted ? String(r.posted).slice(0, 10) : null,
        remote: isRemote(r.location, r.remote),
      });
    }
  }

  /* The same role can appear twice under different guessed slugs. */
  const seenUrl = new Set();
  const unique = jobs.filter(j => seenUrl.has(j.url) ? false : (seenUrl.add(j.url), true));
  unique.sort((a, b) => String(b.posted || '').localeCompare(String(a.posted || '')));

  const out = {
    updated: new Date().toISOString(),
    companies: Object.keys(registry).length,
    count: unique.length,
    jobs: unique,
  };

  fs.writeFileSync(`${__dirname}/jobs.json`, JSON.stringify(out, null, 1));
  fs.writeFileSync(`${__dirname}/companies.json`, JSON.stringify(registry, null, 1));

  const tally = key => unique.reduce((m, j) => (m[j[key]] = (m[j[key]] || 0) + 1, m), {});
  const show = obj => Object.entries(obj).sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${String(k).padEnd(12)} ${n}`));

  console.log(`\n${best.size}/${names.length} boards live (${Math.round(best.size / names.length * 100)}%)`);
  console.log(`${scanned} open roles scanned, ${unique.length} creative\n`);
  show(tally('discipline'));
  console.log('');
  show(tally('type'));
  console.log(`\n${unique.filter(j => j.remote).length} remote`);
  console.log('Wrote jobs.json');
})();
