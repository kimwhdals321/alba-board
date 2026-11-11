import { writeFileSync } from "node:fs";

const HOME = { lat: 37.2772, lng: 127.0168 };
const MAX_KM = 35;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const AM_KEYWORDS = ["수원 당일지급", "수원 야간", "수원 단기", "수원 오늘", "수원 하루", "팔달구", "수원역", "수원 저녁"];
const DG_REGION = 1290;
const DG_KEYWORDS = ["", "당일", "오늘", "저녁", "야간", "단기", "하루", "물류", "행사"];

const BLOCK = /(엔젤바|\bbar\b|바텐|룸살롱|노래(방|주점|빠)|가라오케|유흥|텐프로|쩜오|하이퍼블릭|토킹|호스트|마사지|면접비|대출|코인|리딩방|선입금|고수익\s*보장|밤알바)/i;

const now = new Date(Date.now() + 9 * 3600 * 1000);
const todayIso = now.toISOString().slice(0, 10);
const mm = now.getUTCMonth() + 1, dd = now.getUTCDate();
const TODAY_TEXT = [`${mm}월${dd}일`, `${mm}월 ${dd}일`, `${mm}/${dd}`, `${mm}.${dd}`, "오늘", "금일"];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "ko-KR,ko;q=0.9" } });
      if (r.ok) return await r.text();
      console.error("HTTP", r.status, url);
    } catch (e) {
      console.error("ERR", e.message, url);
    }
    await sleep(1500);
  }
  return null;
}

function km(lat, lng) {
  if (!lat || !lng) return null;
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(lat - HOME.lat), dLng = toR(lng - HOME.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(HOME.lat)) * Math.cos(toR(lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}

function startHour(t) {
  const m = /(\d{1,2}):(\d{2})/.exec(t || "");
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}

function isEvening(title, timeStr) {
  const t = timeStr || "";
  const s = startHour(t);
  const e = startHour(t.split("~")[1] || "");
  if (/익일/.test(t)) return true;
  if (s !== null && s >= 16.5) return true;
  if (s !== null && e !== null && e <= s) return true;
  if (s !== null && !/협의/.test(t)) return false;
  return /(야간|저녁|석간|밤샘|night)/i.test(title);
}

function mdDates(s) {
  return [...(s || "").matchAll(/(\d{1,2})\/(\d{1,2})/g)].map(m => Number(m[1]) * 100 + Number(m[2]));
}
const TODAY_MD = mm * 100 + dd;

function mentionsToday(text) {
  return TODAY_TEXT.some(t => text.includes(t));
}

function collectAlbamon(obj, out) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) { obj.forEach(x => collectAlbamon(x, out)); return; }
  if (obj.recruitNo && obj.recruitTitle) { out.push(obj); return; }
  for (const k in obj) collectAlbamon(obj[k], out);
}

async function albamon() {
  const items = new Map();
  for (const kw of AM_KEYWORDS) {
    for (const page of [1, 2]) {
      const url = `https://www.albamon.com/total-search?keyword=${encodeURIComponent(kw)}&page=${page}&size=50`;
      const html = await get(url);
      if (!html) continue;
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) { console.error("no NEXT_DATA", kw, page); continue; }
      const list = [];
      try { collectAlbamon(JSON.parse(m[1]).props.pageProps.dehydratedState, list); } catch (e) { console.error("parse", e.message); continue; }
      for (const x of list) {
        if (items.has(x.recruitNo)) continue;
        const title = x.recruitTitle || "";
        const company = (x.companyName || "").trim();
        const text = `${title} ${company} ${x.filterTotal || ""}`;
        const dist = km(x.latitude, x.longitude);
        const area = x.workplaceArea || "";
        if (dist !== null && dist > MAX_KM) continue;
        if (dist === null && !area.includes("수원")) continue;
        const sameDay = (x.payAddTypes || []).some(p => p.key === "PAY_THE_DAY") || /당일\s*지급/.test(title);
        const time = x.workingTime || "";
        const wd = mdDates(x.workingDate);
        if (wd.length && wd.every(d => d < TODAY_MD) && TODAY_MD - Math.max(...wd) < 600) continue;
        items.set(x.recruitNo, {
          id: `am-${x.recruitNo}`,
          src: "알바몬",
          title,
          company,
          pay: `${x.payType?.description || ""} ${x.pay || ""}`.trim(),
          time,
          days: [x.workingDate, x.workingWeek, x.workingPeriod].filter(Boolean).join(" · "),
          area: /^(경기|서울|인천|충남|충북|강원)/.test(x.workplaceAddress || "") ? x.workplaceAddress : `${area} ${x.workplaceAddress || ""}`.trim(),
          km: dist,
          posted: x.postedDate || "",
          closing: x.closingDate || "",
          sameDay,
          evening: isEvening(title, time),
          today: wd.includes(TODAY_MD) || (!wd.length && mentionsToday(title)),
          blocked: BLOCK.test(text),
          url: `https://www.albamon.com/jobs/detail/${x.recruitNo}`,
        });
      }
      await sleep(700);
    }
  }
  return [...items.values()];
}

function unesc(s) {
  try { return JSON.parse(`"${s}"`); } catch { return s; }
}

function parseDaangn(html) {
  const out = [];
  const re = /__typename:"JobPost",title:"((?:[^"\\]|\\.)*)",daangnPermalink:\$R\[\d+\]=\{__ref:"([^"]+)"\},_id:"([^"]+)",companyName:(?:"((?:[^"\\]|\\.)*)"|null),publishedAt:"([^"]+)"([\s\S]*?)isWorkTimeNegotiable:([^,}]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[6];
    const regionRef = (/workplaceRegion:\$R\[\d+\]=\{__ref:"([^"]+)"\}/.exec(body) || [])[1];
    const salary = (/stringifiedSalary:"((?:[^"\\]|\\.)*)"/.exec(body) || [])[1] || "";
    const closed = /closed:!0/.test(body);
    const dates = ((/workDates:\$R\[\d+\]=\[([^\]]*)\]/.exec(body) || [])[1] || "").match(/\d{4}-\d{2}-\d{2}/g) || [];
    const days = ((/workDays:\$R\[\d+\]=\[([^\]]*)\]/.exec(body) || [])[1] || "").match(/[A-Z]{3}/g) || [];
    const ts = (/workTimeStart:"([^"]*)"/.exec(body) || [])[1] || "";
    const te = (/workTimeEnd:"([^"]*)"/.exec(body) || [])[1] || "";
    const nego = /!0|true/.test(m[7]);
    let publicId = null;
    const pm = new RegExp(`"?${m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?:\\$R\\[\\d+\\]=\\{__id:"[^"]+",__typename:"Permalink",publicId:"([^"]+)"`).exec(html);
    if (pm) publicId = pm[1];
    let region = "";
    if (regionRef) {
      const rm = new RegExp(`__id:"${regionRef}",__typename:"Region",(?:name3Region:\\$R\\[\\d+\\]=\\{[^}]*\\},)?name:"([^"]+)"`).exec(html);
      if (rm) region = rm[1];
    }
    out.push({
      _id: m[3], title: unesc(m[1]), company: m[4] ? unesc(m[4]) : "", publishedAt: m[5], salary: unesc(salary),
      closed, dates, days, ts, te, nego, publicId, region,
    });
  }
  return out;
}

const DAY_KO = { MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일" };

async function daangn() {
  const items = new Map();
  for (const kw of DG_KEYWORDS) {
    const url = `https://jobs.daangn.com/s?regionId=${DG_REGION}${kw ? `&query=${encodeURIComponent(kw)}` : ""}`;
    const html = await get(url);
    if (!html) continue;
    const list = parseDaangn(html);
    if (!list.length) console.error("daangn: 0 parsed", kw);
    for (const x of list) {
      if (x.closed || items.has(x._id)) continue;
      if (x.dates.length && x.dates.every(d => d < todayIso)) continue;
      const anyTime = !x.ts || (x.ts === "00:00" && x.te === "23:30");
      const time = anyTime ? "시간 협의" : `${x.ts}~${x.te}${x.nego ? " 협의" : ""}`;
      const text = `${x.title} ${x.company}`;
      const today = x.dates.includes(todayIso);
      const daysText = x.dates.length
        ? x.dates.map(d => (d === todayIso ? "오늘" : d.slice(5).replace("-", "/"))).join(", ")
        : x.days.map(d => DAY_KO[d] || d).join(",");
      items.set(x._id, {
        id: `dg-${x._id}`,
        src: "당근",
        title: x.title,
        company: x.company,
        pay: x.salary,
        time,
        days: daysText,
        area: x.region,
        km: null,
        posted: x.publishedAt,
        closing: "",
        sameDay: /당일\s*지급/.test(text),
        evening: anyTime || isEvening(x.title, `${x.ts}~${x.te}`) || (startHour(x.te) !== null && startHour(x.te) >= 20),
        today: today || mentionsToday(x.title),
        blocked: BLOCK.test(text),
        url: x.publicId ? `https://www.daangn.com/kr/jobs/${x.publicId}/` : `https://jobs.daangn.com/s?regionId=${DG_REGION}`,
      });
    }
    await sleep(700);
  }
  return [...items.values()];
}

const [am, dg] = await Promise.all([albamon(), daangn()]);
console.log(`albamon ${am.length}, daangn ${dg.length}`);
if (am.length + dg.length === 0) {
  console.error("nothing collected; keeping previous data.json");
  process.exit(1);
}
const items = [...am, ...dg].filter(x => !x.blocked).map(({ blocked, ...rest }) => rest);
writeFileSync(new URL("./data.json", import.meta.url), JSON.stringify({
  updated: new Date().toISOString(),
  counts: { albamon: am.length, daangn: dg.length, hidden: am.length + dg.length - items.length },
  items,
}));
console.log(`wrote ${items.length} items`);
