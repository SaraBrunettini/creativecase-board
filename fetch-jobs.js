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
/* Pay, where a company chooses to publish it. Greenhouse and Ashby both hold
   it back unless the request asks for it, and roughly one role in six carries
   a figure - so this is a line the card shows when it can and leaves out when
   it cannot, never an empty "Salary: not specified". */
const CURRENCY = {
  GBP: '\u00a3', EUR: '\u20ac', USD: '$', CHF: 'CHF ', PLN: 'PLN ', SEK: 'SEK ',
  NOK: 'NOK ', DKK: 'DKK ', CZK: 'CZK ', HUF: 'HUF ', RON: 'RON ', BGN: 'BGN ',
  UAH: 'UAH ', TRY: 'TRY ',
};
const PER = { MONTH: ' a month', WEEK: ' a week', DAY: ' a day', HOUR: ' an hour' };

const amount = (n) => {
  if (!(n > 0)) return null;
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return (Number.isInteger(k) ? k : k.toFixed(1).replace(/[.]0$/, '')) + 'K';
};

/* Takes { min, max, currency, interval } and returns \u00a365K \u2013 \u00a372K. */
function salary(pay) {
  if (!pay) return null;
  const lo = amount(pay.min), hi = amount(pay.max);
  if (!lo && !hi) return null;
  const sym = CURRENCY[pay.currency] || (pay.currency ? pay.currency + ' ' : '');
  const per = PER[pay.interval] || '';
  return lo && hi && lo !== hi
    ? sym + lo + ' \u2013 ' + sym + hi + per
    : sym + (lo || hi) + per;
}

/* Ordering pay means comparing three currencies over two intervals, so each
   figure also gets an annual euro estimate. It is only ever used to sort:
   the card always shows the company's own wording. Rates come from the ECB
   each morning, with a fallback so a rate outage cannot break the run. */
const PER_YEAR = { YEAR: 1, MONTH: 12, WEEK: 52, DAY: 230, HOUR: 1750 };

const FALLBACK_RATES = {
  EUR: 1, GBP: 0.86, USD: 1.08, CHF: 0.94, PLN: 4.38, SEK: 11.27, NOK: 11.6,
  DKK: 7.46, CZK: 25.2, HUF: 395, RON: 4.98, BGN: 1.96, UAH: 45, TRY: 38,
};
let RATES = { ...FALLBACK_RATES };

async function loadRates() {
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR',
      { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (d && d.rates) {
      RATES = { EUR: 1, ...d.rates };
      console.log(`Rates from ECB, ${d.date}`);
      return;
    }
    throw new Error('no rates');
  } catch (e) {
    console.log('Rates unavailable, using fallback:', e.message);
  }
}

/* Annual euros, from the midpoint of the range. */
function salaryEur(pay) {
  if (!pay) return null;
  const lo = pay.min > 0 ? pay.min : null;
  const hi = pay.max > 0 ? pay.max : null;
  const mid = lo && hi ? (lo + hi) / 2 : (lo || hi);
  if (!mid) return null;
  const rate = RATES[pay.currency];
  if (!rate) return null;
  const perYear = PER_YEAR[pay.interval] || 1;
  return Math.round((mid * perYear) / rate);
}

/* Each board states pay in its own shape. */
const ghPay = (ranges) => {
  const r = (ranges || []).find((x) => x && (x.min_cents || x.max_cents));
  return r && { min: r.min_cents / 100, max: r.max_cents / 100,
    currency: r.currency_type, interval: /hour/i.test(r.title || '') ? 'HOUR' : 'YEAR' };
};

const leverPay = (r) => {
  if (!r || !(r.min || r.max)) return null;
  const i = String(r.interval || '');
  return { min: r.min, max: r.max, currency: r.currency,
    interval: /hour/i.test(i) ? 'HOUR' : /month/i.test(i) ? 'MONTH'
            : /week/i.test(i) ? 'WEEK' : /day/i.test(i) ? 'DAY' : 'YEAR' };
};

const ashbyPay = (c) => {
  const parts = [].concat(
    (c && c.summaryComponents) || [],
    (((c && c.compensationTiers) || [])[0] || {}).components || []);
  const p = parts.find((x) =>
    x && x.compensationType === 'Salary' && (x.minValue || x.maxValue));
  return p && { min: p.minValue, max: p.maxValue, currency: p.currencyCode,
    interval: String(p.interval || '').trim().split(' ').pop() };
};

const ISO = {
  GB: 'United Kingdom', UK: 'United Kingdom', IE: 'Ireland', DE: 'Germany',
  FR: 'France', NL: 'Netherlands', BE: 'Belgium', ES: 'Spain', PT: 'Portugal',
  IT: 'Italy', PL: 'Poland', DK: 'Denmark', SE: 'Sweden', NO: 'Norway',
  FI: 'Finland', CH: 'Switzerland', AT: 'Austria', CZ: 'Czechia', HU: 'Hungary',
  RO: 'Romania', BG: 'Bulgaria', RS: 'Serbia', HR: 'Croatia', GR: 'Greece',
  LT: 'Lithuania', LV: 'Latvia', EE: 'Estonia', UA: 'Ukraine', LU: 'Luxembourg',
  IS: 'Iceland', SI: 'Slovenia', SK: 'Slovakia', MT: 'Malta', CY: 'Cyprus',
  TR: 'Turkey', US: 'United States', CA: 'Canada', IN: 'India', SG: 'Singapore',
};

const ATS = {
  greenhouse: {
    url: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?pay_transparency=true`,
    rows: d => (d.jobs || []).map(j => ({
      title: j.title,
      location: j.location && j.location.name,
      url: j.absolute_url,
      posted: j.first_published || j.updated_at,
      pay: ghPay(j.pay_input_ranges),
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
      work: j.workplaceType,
      pay: leverPay(j.salaryRange),
    })),
  },
  /* Recruitee localises the country name - "Nederland", "Zweden" - so the
     ISO code is the only reliable read. */
  recruitee: {
    url: s => `https://${s}.recruitee.com/api/offers/`,
    rows: d => (d.offers || []).map(j => ({
      title: j.title,
      location: [j.city, ISO[j.country_code] || j.country].filter(Boolean).join(', '),
      url: j.careers_url || j.careers_apply_url,
      posted: j.published_at && String(j.published_at).replace(' UTC', 'Z').replace(' ', 'T'),
      type: j.employment_type_code,
      work: j.remote ? 'remote' : j.hybrid ? 'hybrid' : '',
      pay: j.salary && { min: j.salary.min, max: j.salary.max,
        currency: j.salary.currency, interval: String(j.salary.period || '').toUpperCase() },
    })),
  },
  ashby: {
    url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`,
    rows: d => (d.jobs || []).map(j => ({
      title: j.title,
      location: j.location,
      url: j.jobUrl || j.applyUrl,
      posted: j.publishedAt,
      type: j.employmentType,
      work: j.isRemote ? 'remote' : '',
      pay: ashbyPay(j.compensation),
    })),
  },
};

/* What counts as a creative role at all. */
const CREATIVE = /(\bdesign|\bcreative|\billustrat|\bbrand\b|\bgraphic|\bux\b|\bui\b|\buser experience|\buser interface|\bmotion|\banimat|\bcopywriter|\bcontent design|\bcontent strateg|\bux writ|\bart director|\buser research|\btypograph|\bvisual|\bvideo editor|\bvideo artist|\bvideographer|\bcontent producer|\bsocial producer|\bstudio producer)/i;

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
  'creative strateg|performance creative(?! designer)|forward deployed|brand ambassador',
  'account manager|account director|client partner',
].join('|'), 'i');

/* Which bucket a role belongs in. First match wins, so order matters:
   seniority beats craft, and the narrow crafts are tested before the wide
   ones. Anything creative that fits none of them lands in Other. */
const DISCIPLINES = [
  ['Leadership',   /\b(head of (design|creative|brand|ux|product)|(design|creative|art|brand) director|director,? of (product |global )?(design|ux|creative|brand)|(vp|vice president),? (of )?(design|creative|ux)|design manager|design lead|creative lead|director,? ux|director ux design)\b/i],
  ['Research',     /\b(ux research|uxr|user research|design research|user experience research|researcher)/i],
  ['Content',      /\b(content design|content strateg|ux writ|ux copy|copywriter|content lead|content producer)/i],
  ['Motion',       /(\bmotion|\banimator|\banimation|\b3d |\bvideo editor|\bvideo artist|\bvideographer)/i],
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
    if (r.includes('freelance') || r.includes('fixedterm')) return 'Contract';
  }
  for (const [name, re] of TYPE_WORDS) if (re.test(title || '')) return name;
  return 'Full-time';
}

/* Remote / Hybrid / On-site. Lever states it outright and Ashby has a remote
   flag; otherwise it is read off the location, and a location that says
   nothing is treated as on-site. */
function workplace(raw, loc) {
  const r = String(raw || '').toLowerCase();
  if (r.includes('hybrid')) return 'Hybrid';
  if (r.includes('remote')) return 'Remote';
  const l = String(loc || '');
  if (/\bhybrid\b/i.test(l)) return 'Hybrid';
  if (/\bremote\b|\bwork from home\b|\bfully distributed\b/i.test(l)) return 'Remote';
  return 'On-site';
}

const NOT_A_CITY = new RegExp('^(' + [
  'remote|hybrid|on-?site|in-?office|anywhere|worldwide|global|flexible',
  'multiple locations|various|any location|distributed|field|home',
  'europe|emea|apac|americas|north america|south america|latam|asia|africa|middle east',
  'united states|usa|us|uk|united kingdom|england|scotland|wales|ireland|germany|deutschland',
  'france|spain|portugal|italy|netherlands|belgium|poland|denmark|sweden|norway|finland',
  'switzerland|austria|czechia|czech republic|hungary|romania|bulgaria|serbia|croatia|greece',
  'lithuania|latvia|estonia|ukraine|turkey|luxembourg|canada|mexico|brazil|argentina|colombia',
  'chile|peru|india|singapore|philippines|indonesia|malaysia|vietnam|thailand|japan',
  'south korea|china|hong kong|taiwan|australia|new zealand|israel|uae|kuwait|saudi arabia',
  'egypt|south africa|nigeria|kenya|other|not stated',
].join('|') + ')$', 'i');

/* Country, from a free-text location. */
const COUNTRIES = [
  ['United Kingdom', /\b(uk|united kingdom|england|scotland|wales|london|manchester|bristol|edinburgh|glasgow|cambridge|oxford|leeds|brighton|cardiff|reading|belfast)\b/],
  ['Ireland',        /\b(dublin|ireland|cork)\b/],
  ['Germany',        /\b(berlin|munich|munchen|hamburg|frankfurt|cologne|koln|dusseldorf|stuttgart|germany|deutschland)\b/],
  ['France',         /\b(paris|france|lyon|bordeaux|marseille|nantes|toulouse|lille)\b/],
  ['Netherlands',    /\b(amsterdam|rotterdam|utrecht|eindhoven|almere|the hague|netherlands)\b/],
  ['Spain',          /\b(madrid|barcelona|valencia|seville|malaga|spain)\b/],
  ['Portugal',       /\b(lisbon|lisboa|porto|portugal)\b/],
  ['Italy',          /\b(milan|milano|rome|roma|turin|italy)\b/],
  ['Poland',         /\b(warsaw|warszawa|krak|wroc|gdansk|poznan|poland)\b/],
  ['Denmark',        /\b(copenhagen|kobenhavn|aarhus|denmark)\b/],
  ['Sweden',         /\b(stockholm|gothenburg|malmo|sweden)\b/],
  ['Norway',         /\b(oslo|norway)\b/],
  ['Finland',        /\b(helsinki|finland)\b/],
  ['Switzerland',    /\b(zurich|zuerich|geneva|basel|lausanne|switzerland)\b/],
  ['Austria',        /\b(vienna|wien|austria)\b/],
  ['Belgium',        /\b(brussels|antwerp|ghent|belgium)\b/],
  ['Czechia',        /\b(prague|praha|brno|czech)\b/],
  ['Hungary',        /\b(budapest|hungary)\b/],
  ['Romania',        /\b(bucharest|cluj|romania)\b/],
  ['Bulgaria',       /\b(sofia|bulgaria)\b/],
  ['Serbia',         /\b(belgrade|novi sad|serbia)\b/],
  ['Croatia',        /\b(zagreb|croatia)\b/],
  ['Greece',         /\b(athens|greece)\b/],
  ['Lithuania',      /\b(vilnius|kaunas|lithuania)\b/],
  ['Latvia',         /\b(riga|latvia)\b/],
  ['Estonia',        /\b(tallinn|tartu|estonia)\b/],
  ['Ukraine',        /\b(kyiv|kiev|lviv|ukraine)\b/],
  ['Turkey',         /\b(istanbul|ankara|turkey|turkiye)\b/],
  ['Luxembourg',     /\bluxembourg\b/],
  ['United States',  /\b(usa|u\.s\.|united states|new york|nyc|brooklyn|san francisco|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|portland|remote, us)\b/],
  ['Canada',         /\b(canada|toronto|vancouver|montreal|ottawa)\b/],
  ['Mexico',         /\b(mexico|guadalajara|monterrey)\b/],
  ['Brazil',         /\b(brazil|brasil|sao paulo|rio de janeiro)\b/],
  ['Argentina',      /\b(argentina|buenos aires)\b/],
  ['Colombia',       /\b(colombia|bogota|medellin)\b/],
  ['Chile',          /\b(chile|santiago)\b/],
  ['Peru',           /\b(peru|lima)\b/],
  ['India',          /\b(india|bangalore|bengaluru|mumbai|delhi|gurgaon|hyderabad|pune|chennai)\b/],
  ['Singapore',      /\bsingapore\b/],
  ['Philippines',    /\b(philippines|manila|cebu)\b/],
  ['Indonesia',      /\b(indonesia|jakarta)\b/],
  ['Malaysia',       /\b(malaysia|kuala lumpur)\b/],
  ['Vietnam',        /\b(vietnam|hanoi|ho chi minh)\b/],
  ['Thailand',       /\b(thailand|bangkok)\b/],
  ['Japan',          /\b(japan|tokyo|osaka)\b/],
  ['South Korea',    /\b(south korea|seoul)\b/],
  ['China',          /\b(china|beijing|shanghai|shenzhen)\b/],
  ['Hong Kong',      /\bhong kong\b/],
  ['Taiwan',         /\b(taiwan|taipei)\b/],
  ['Australia',      /\b(australia|sydney|melbourne|brisbane)\b/],
  ['New Zealand',    /\b(new zealand|auckland|wellington)\b/],
  ['Israel',         /\b(israel|tel aviv)\b/],
  ['UAE',            /\b(dubai|abu dhabi|uae|united arab)\b/],
  ['Kuwait',         /\bkuwait\b/],
  ['Saudi Arabia',   /\b(saudi|riyadh|jeddah)\b/],
  ['Egypt',          /\b(egypt|cairo)\b/],
  ['South Africa',   /\b(south africa|cape town|johannesburg)\b/],
  ['Nigeria',        /\b(nigeria|lagos)\b/],
  ['Kenya',          /\b(kenya|nairobi)\b/],
  ['Iceland',        /\b(iceland|reykjavik)\b/],
  ['Slovenia',       /\b(slovenia|ljubljana)\b/],
  ['Slovakia',       /\b(slovakia|bratislava|kosice)\b/],
  ['Malta',          /\b(malta|valletta)\b/],
  ['Cyprus',         /\b(cyprus|nicosia|limassol)\b/],
  ['Georgia (country)', /\b(tbilisi)\b/],
  ['Kazakhstan',     /\b(kazakhstan|almaty|astana)\b/],
  ['Morocco',        /\b(morocco|casablanca|marrakesh|rabat)\b/],
  ['Ghana',          /\b(ghana|accra)\b/],
  ['Uruguay',        /\b(uruguay|montevideo)\b/],
  ['Costa Rica',     /\b(costa rica|san jose, cr)\b/],
  ['Armenia',        /\b(armenia|yerevan)\b/],
  ['Moldova',        /\b(moldova|chisinau)\b/],
  ['Bosnia',         /\b(bosnia|sarajevo)\b/],
  ['North Macedonia',/\b(macedonia|skopje)\b/],
  ['Albania',        /\b(albania|tirana)\b/],
  ['Montenegro',     /\bmontenegro\b/],
  ['Pakistan',       /\b(pakistan|karachi|lahore|islamabad)\b/],
  ['Bangladesh',     /\b(bangladesh|dhaka)\b/],
  ['Sri Lanka',      /\b(sri lanka|colombo)\b/],
  ['Nepal',          /\b(nepal|kathmandu)\b/],
];

/* Places the table does not know. A location like "Reykjavik, Iceland" names
   its country in the last segment, so take it - but only when there IS a last
   segment, or a bare town name would be mistaken for a country. */
const US_STATES = new RegExp('^(' + [
  'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia',
  'hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland',
  'massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada',
  'new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma',
  'oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah',
  'vermont|virginia|washington|west virginia|wisconsin|wyoming',
].join('|') + ')$', 'i');

function country(loc) {
  const raw = String(loc || '');
  const l = raw.toLowerCase();
  for (const [name, re] of COUNTRIES) if (re.test(l)) return name;

  const parts = raw.split(/[;,]/).map(x => x.replace(/\(.*?\)/g, '').trim()).filter(Boolean);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (last.length >= 4 && /^[\p{L}\p{M} '.-]+$/u.test(last)
        && !NOT_A_CITY.test(last) && !US_STATES.test(last)
        && !/\b(voivodeship|province|state|region|county|district|area|metro)\b/i.test(last)) {
      return last.replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  return 'Other';
}

/* City. Locations are free text, so take the first segment that looks like a
   place name rather than a country, a region or the word Remote. */
const CITY_ALIAS = {
  warszawa: 'Warsaw', munchen: 'Munich', muenchen: 'Munich', koln: 'Cologne',
  koeln: 'Cologne', zuerich: 'Zurich', wroclaw: 'Wroclaw', krakow: 'Krakow',
  lisboa: 'Lisbon', milano: 'Milan', roma: 'Rome', praha: 'Prague',
  wien: 'Vienna', kobenhavn: 'Copenhagen', nyc: 'New York',
  'new york city': 'New York', bengaluru: 'Bangalore', kiev: 'Kyiv',
  zurich: 'Zurich', 'sf': 'San Francisco', 'bay area': 'San Francisco',
};

function city(loc) {
  const raw = String(loc || '');
  for (let part of raw.split(/[;,/]|\s+-\s+|\s+or\s+|\s+and\s+/i)) {
    part = part.replace(/\(.*?\)/g, '')            // drop "(UK)"
               .replace(/^(uk|us|usa|de|fr|es|nl)\s+/i, '')  // drop "UK London"
               .replace(/[^\p{L}\p{M}\s'.-]/gu, '')
               .replace(/\s+/g, ' ').trim()
               .replace(/\s+(office|hq|headquarters)$/i, '');   // "Paris office" -> "Paris"
    if (!part || part.length < 2 || part.length > 28) continue;
    if (/^all\s/i.test(part)) continue;              // "All France" is a country
    if (NOT_A_CITY.test(part)) continue;
    if (/\b(voivodeship|province|state|region|county|district|area|metro|prefecture)\b/i.test(part)) continue;
    const key = part.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (CITY_ALIAS[key]) return CITY_ALIAS[key];
    return part;
  }
  return null;
}

/* The board is European. A role qualifies if it sits in a European country,
   or if it is remote and open widely enough that someone in Europe could take
   it. A remote role pinned to another country usually needs the right to work
   there, so "Remote - United States" does not qualify. */
const EUROPE = new Set([
  'United Kingdom','Ireland','Germany','France','Netherlands','Spain','Portugal',
  'Italy','Poland','Denmark','Sweden','Norway','Finland','Switzerland','Austria',
  'Belgium','Czechia','Hungary','Romania','Bulgaria','Serbia','Croatia','Greece',
  'Lithuania','Latvia','Estonia','Ukraine','Luxembourg','Iceland','Slovenia',
  'Slovakia','Malta','Cyprus','Turkey','Moldova','Bosnia','North Macedonia',
  'Albania','Montenegro',
]);
const OPEN_TO_EUROPE = /\b(europe|emea|global|worldwide|anywhere)\b/i;

const inEurope = (countryName, loc, work) =>
  EUROPE.has(countryName) ||
  (work === 'Remote' && (OPEN_TO_EUROPE.test(loc) || /^\s*remote\s*$/i.test(loc)));

/* A role has to be a month old at most. A board still showing a job that
   closed in the spring is worse than a short board: it costs someone an
   application to find out. */
const MAX_AGE_DAYS = 31;
const isRecent = (posted) => {
  const t = Date.parse(posted);
  return Number.isFinite(t) && Date.now() - t <= MAX_AGE_DAYS * 864e5;
};

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
    return { slug, ats, rows };
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

  await loadRates();

  /* One company per line. A line may name its board outright —
       Fever | feverup | greenhouse
     — and otherwise the board name is guessed from the company name. */
  const pinned = {};
  const names = fs.readFileSync(`${__dirname}/companies.txt`, 'utf8')
    .split('\n').map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
    .map(line => {
      const [name, slug, ats] = line.split('|').map(p => p.trim());
      if (slug && ATS[ats]) pinned[name] = { slug, ats };
      return name;
    });

  /* A confirmed board is remembered, so we stop guessing after the first
     success and the run gets faster over time. */
  let known = {};
  try { known = JSON.parse(fs.readFileSync(`${__dirname}/companies.json`, 'utf8')); } catch {}

  const targets = [];
  for (const name of names) {
    const hit = pinned[name] || known[name];
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

  /* Every company we have ever confirmed keeps its entry, so a quiet board
     is never re-guessed and a company can sit on the list for months before
     it posts anything. */
  const registry = {}, jobs = [];
  for (const name of names) if (known[name]) registry[name] = known[name];
  let scanned = 0;
  for (const [name, f] of best) {
    registry[name] = { slug: f.slug, ats: f.ats, seen: new Date().toISOString().slice(0, 10) };
    scanned += f.rows.length;
    for (const r of f.rows) {
      const disc = discipline(r.title);
      if (!disc) continue;
      if (!isRecent(r.posted)) continue;
      const loc = (r.location || 'Not stated').trim();
      const where = country(loc);
      const work = workplace(r.work, loc);
      if (!inEurope(where, loc, work)) continue;
      jobs.push({
        title: r.title.trim(),
        company: name,
        location: loc,
        country: where,
        city: city(loc),
        discipline: disc,
        type: employmentType(r.type, r.title),
        workplace: work,
        salary: salary(r.pay),
        salaryEur: salaryEur(r.pay),
        url: r.url,
        posted: r.posted ? String(r.posted).slice(0, 10) : null,
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
    .forEach(([k, n]) => console.log(`  ${String(k).padEnd(16)} ${n}`));

  console.log(`\n${best.size}/${names.length} boards live (${Math.round(best.size / names.length * 100)}%)`);
  console.log(`${scanned} open roles scanned, ${unique.length} creative\n`);
  show(tally('discipline'));
  console.log('');
  show(tally('workplace'));
  console.log('');
  show(tally('type'));
  console.log(`\n${new Set(unique.map(j => j.city).filter(Boolean)).size} cities, ` +
              `${new Set(unique.map(j => j.country)).size} countries`);
  console.log('Wrote jobs.json');
})();
