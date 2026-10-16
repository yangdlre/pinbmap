// 핀볼 지도 — ② 종합 점수 (별점 없이 매기는 가게 점수)
// POST {places:[{id,n(이름),a(지번 주소),x,y}]} 최대 10곳 → {srcs:{…}, res:{id:{s, N, parts, ad}}}
// POST {probe:1} → 어떤 자료가 연결돼 있는지만 (키 값은 절대 돌려주지 않음)
//
// 쓰는 자료 (Netlify 환경변수에 키가 있는 것만 씀 — 없으면 그 항목은 빼고 나머지로 100점 환산)
//   NAVER_ID / NAVER_SECRET : 네이버 블로그·카페 검색, 데이터랩 검색어 트렌드
//   KAKAO_REST              : 다음 블로그 검색 (카카오 REST API 키)
//   YT_KEY                  : 유튜브 검색 (Google YouTube Data API v3)
//   TOUR_KEY                : 한국관광공사 TourAPI (공공데이터포털 일반 인증키, Decoding 값)
//   NAVER_ID·NAVER_SECRET   : NAVER API HUB Application의 Client ID·Client Secret (예전 개발자센터 키면 NAVER_OLD=1도)
//   우리 앱 기록             : 키 필요 없음 — 가입자들의 다녀온 곳·가고 싶은 곳 (개수만 집계)
//
// 광고 글: 요약글에 협찬·체험단·원고료 등이 보이면 그 글은 집계에서 아예 뺌.
//          가게 이름이 안 나오는 글(무관한 글)도 뺌. 표본의 절반 이상이 광고면 그 가게의 블로그 점수는 0.
import { getStore } from '@netlify/blobs';

const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const ENV = k => String(process.env[k] || '').trim();
const AD = /협찬|체험단|원고료|소정의|제공\s?받|지원\s?받|무료로\s?제공|업체로부터|광고|서포터즈|기자단|리뷰어|초대받/;
const W = { blog: 30, recent: 15, daum: 15, cafe: 5, trend: 10, yt: 5, tour: 10, ours: 15 };
const TTL = 7 * 864e5, AGG_TTL = 6 * 36e5;

const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ');
const norm = s => strip(s).replace(/\s+/g, '').toLowerCase();
const logN = (n, top) => Math.max(0, Math.min(1, Math.log10(1 + (+n || 0)) / Math.log10(1 + top)));
const srcs = () => ({ naver: !!(ENV('NAVER_ID') && ENV('NAVER_SECRET')), daum: !!ENV('KAKAO_REST'), yt: !!ENV('YT_KEY'), tour: !!ENV('TOUR_KEY'), ours: true });
const sig = () => Object.entries(srcs()).map(([k, v]) => v ? k : '').join('');

function scoreStore() { return globalThis.__pinbScoreStore || getStore({ name: 'pinb-score', consistency: 'strong' }); }
function roomStore() { return globalThis.__pinbStore || getStore({ name: 'pinb-rooms', consistency: 'strong' }); }

async function getJSON(url, opt = {}, ms = 6000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { ...opt, signal: c.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}
// 가게 이름 기준말: '○○ 애월점' → '○○' (지점명 빼고 본 이름이 글에 나오면 관련 글로 봄)
function keyOf(name) {
  const t = String(name || '').trim().split(/\s+/);
  return norm(t.length > 1 && /점$/.test(t[t.length - 1]) ? t.slice(0, -1).join('') : t.join(''));
}
function dongOf(addr) {
  const a = String(addr || '').split(/\s+/);
  return a.find(x => /(동|읍|면|가|리)$/.test(x) && !/(시|도|군|구)$/.test(x)) || a[2] || '';
}
// 표본 글 세기: 관련 글(rel) 중 광고(ad)는 빼고 진짜 글(ok), 최근 90일·1년
function sample(items, key, dateOf) {
  let rel = 0, ad = 0, good = 0, r90 = 0, r365 = 0;
  const now = Date.now();
  for (const it of items || []) {
    const txt = strip(it.title) + ' ' + strip(it.description || it.contents);
    if (!key || !norm(txt).includes(key)) continue;
    rel++;
    if (AD.test(txt)) { ad++; continue; }
    good++;
    const d = dateOf(it);
    if (d) { const age = now - d; if (age < 90 * 864e5) r90++; if (age < 365 * 864e5) r365++; }
  }
  return { n: (items || []).length, rel, ad, good, r90, r365 };
}
const nDate = it => { const s = String(it.postdate || ''); return /^\d{8}$/.test(s) ? Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) : 0; };
const kDate = it => Date.parse(it.datetime) || 0;
// 네이버 검색: 2026.7.31부터 새 키는 NAVER API HUB(네이버 클라우드)에서만 발급 → HUB 주소·헤더로 부름.
// 예전 개발자센터 키(2027.6.30까지)를 넣었으면 NAVER_OLD=1. 결과는 화면에 그대로 보여 주지 않고 언급 수만 셈 — AI에는 넣지 않음(네이버 약관).
const NV_OLD = () => ENV('NAVER_OLD') === '1';
const nvHead = () => NV_OLD() ? { 'X-Naver-Client-Id': ENV('NAVER_ID'), 'X-Naver-Client-Secret': ENV('NAVER_SECRET') } : { 'X-NCP-APIGW-API-KEY-ID': ENV('NAVER_ID'), 'X-NCP-APIGW-API-KEY': ENV('NAVER_SECRET') };
const naver = (path, q, extra) => getJSON(NV_OLD() ? `https://openapi.naver.com/v1/search/${path}.json?query=${encodeURIComponent(q)}${extra}` : `https://naverapihub.apigw.ntruss.com/search/v1/${path}?query=${encodeURIComponent(q)}${extra}`,
  { headers: nvHead() });
const tourKey = () => { const k = ENV('TOUR_KEY'); return /%[0-9A-F]{2}/i.test(k) ? k : encodeURIComponent(k); };   // Encoding 값을 넣어도 동작

async function onePlace(p) {
  const key = keyOf(p.n), q = `${p.n} ${dongOf(p.a)}`.trim(), parts = {}, S = srcs(), jobs = [];
  if (S.naver) jobs.push((async () => {
    const [a, b, c] = await Promise.all([naver('blog', q, '&display=100&sort=sim'), naver('blog', q, '&display=100&sort=date'), naver('cafearticle', q, '&display=50&sort=sim')]);
    if (a) { const s = sample(a.items, key, nDate); parts.blog = { total: a.total || 0, est: s.n ? Math.round((a.total || 0) * s.good / s.n) : 0, ad: s.ad, rel: s.rel, n: s.n }; }
    if (b) { const s = sample(b.items, key, nDate); parts.recent = { r90: s.r90, r365: s.r365, ad: s.ad }; }
    if (c) { const s = sample(c.items, key, () => 0); parts.cafe = { total: c.total || 0, est: s.n ? Math.round((c.total || 0) * s.good / s.n) : 0 }; }
  })());
  if (S.daum) jobs.push((async () => {
    const d = await getJSON(`https://dapi.kakao.com/v2/search/blog?query=${encodeURIComponent(q)}&size=50&sort=accuracy`, { headers: { Authorization: 'KakaoAK ' + ENV('KAKAO_REST') } });
    if (d && d.meta) { const s = sample(d.documents, key, kDate), t = d.meta.total_count || 0; parts.daum = { total: t, est: s.n ? Math.round(t * s.good / s.n) : 0, ad: s.ad, r90: s.r90, rel: s.rel, n: s.n }; }
  })());
  if (S.yt) jobs.push((async () => {
    const d = await getJSON(`https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=1&q=${encodeURIComponent(q)}&key=${encodeURIComponent(ENV('YT_KEY'))}`);
    if (d && d.pageInfo) parts.yt = { n: d.pageInfo.totalResults || 0 };
  })());
  if (S.tour) jobs.push((async () => {
    const d = await getJSON(`https://apis.data.go.kr/B551011/KorService2/searchKeyword2?serviceKey=${tourKey()}&MobileOS=ETC&MobileApp=pinbmap&_type=json&numOfRows=30&pageNo=1&keyword=${encodeURIComponent(String(p.n || '').split(/\s+/)[0])}`);
    const body = d && d.response && d.response.body;
    if (body) {
      const arr = body.items && body.items.item ? [].concat(body.items.item) : [];
      const hit = arr.some(x => norm(x.title).includes(key) && Math.abs(+x.mapx - +p.x) < 0.01 && Math.abs(+x.mapy - +p.y) < 0.01);
      parts.tour = { hit };
    }
  })());
  await Promise.all(jobs);
  return parts;
}

// 데이터랩: 최근 4주 / 그 전 12주 검색량 비율 (5곳씩 한 번에)
async function trends(list) {
  const out = {};
  if (!srcs().naver || !list.length) return out;
  const end = new Date(Date.now() + 9 * 36e5), start = new Date(end - 16 * 7 * 864e5), f = d => d.toISOString().slice(0, 10);
  for (let i = 0; i < list.length; i += 5) {
    const g = list.slice(i, i + 5);
    const d = await getJSON(NV_OLD() ? 'https://openapi.naver.com/v1/datalab/search' : 'https://naverapihub.apigw.ntruss.com/search-trend/v1/search', { method: 'POST',
      headers: { ...nvHead(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: f(start), endDate: f(end), timeUnit: 'week', keywordGroups: g.map(p => ({ groupName: String(p.id), keywords: [String(p.n).slice(0, 40)] })) }) });
    if (!d || !Array.isArray(d.results)) continue;
    for (const r of d.results) {
      const v = (r.data || []).map(x => +x.ratio || 0);
      if (!v.length) { out[r.title] = { t: null }; continue; }
      const last = v.slice(-4), prev = v.slice(0, -4);
      const a = last.reduce((s, x) => s + x, 0) / Math.max(1, last.length), b = prev.reduce((s, x) => s + x, 0) / Math.max(1, prev.length);
      out[r.title] = { t: b > 0 ? Math.round(a / b * 100) / 100 : (a > 0 ? 2 : null) };
    }
  }
  return out;
}

// 우리 앱 기록: 가입자들의 다녀온 곳(사람 수·횟수)과 가고 싶은 곳(사람 수) — 6시간마다 다시 셈, 개수만 저장
async function ours() {
  const sc = scoreStore();
  const c = await sc.get('agg', { type: 'json' }).catch(() => null);
  if (c && Date.now() - c.t < AGG_TTL) return c.v;
  const st = roomStore(), v = {}, today = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
  const add = id => v[id] || (v[id] = { u: 0, n: 0, s: 0 });
  const { blobs } = await st.list({ prefix: 'acct:' });
  for (const b of blobs.slice(0, 300)) {
    const rec = await st.get(b.key, { type: 'json' }).catch(() => null);
    if (!rec) continue;
    const seen = new Set(), saved = new Set();
    for (const e of Object.values(rec.trips || {})) {
      if (!e || e.del || !e.data) continue;
      const t = e.data.trip || {}, endDay = t.start ? new Date(Date.parse(t.start) + ((+t.days || 1) - 1) * 864e5).toISOString().slice(0, 10) : '';
      const ended = endDay && endDay < today;
      for (const it of e.data.items || []) {
        if (!it || it.del || !it.p || !/^\d+$/.test(String(it.p.id))) continue;
        const went = (it.visited && typeof it.visited === 'object') || (ended && it.visited !== false && it.visited === undefined);
        if (!went) continue;
        const id = String(it.p.id); add(id).n++; seen.add(id);
      }
    }
    for (const x of rec.saved || []) if (x && !x.del && x.p && /^\d+$/.test(String(x.p.id))) saved.add(String(x.p.id));
    seen.forEach(id => v[id].u++); saved.forEach(id => add(id).s++);
  }
  await sc.set('agg', JSON.stringify({ t: Date.now(), v })).catch(() => {});
  return v;
}

function scoreOf(parts, o) {
  const N = {};
  const adHeavy = !!(parts.blog && parts.blog.rel >= 4 && parts.blog.ad / parts.blog.rel >= 0.5);
  if (parts.blog) N.blog = adHeavy ? 0 : logN(parts.blog.est, 3000);
  if (parts.recent) N.recent = adHeavy ? 0 : Math.min(1, parts.recent.r90 / 30 * 0.7 + parts.recent.r365 / 150 * 0.3);
  if (parts.daum) N.daum = (parts.daum.rel >= 4 && parts.daum.ad / parts.daum.rel >= 0.5) ? 0 : logN(parts.daum.est, 3000);
  if (parts.cafe) N.cafe = logN(parts.cafe.est, 1500);
  if (parts.trend && parts.trend.t != null) N.trend = Math.max(0, Math.min(1, (parts.trend.t - 0.5) / 1.5));
  if (parts.yt) N.yt = logN(parts.yt.n, 5000);
  if (parts.tour) N.tour = parts.tour.hit ? 1 : 0;
  N.ours = Math.min(1, ((o.u || 0) * 2 + Math.max(0, (o.n || 0) - (o.u || 0)) + (o.s || 0)) / 6);
  let s = 0, sw = 0;
  for (const k in N) { s += W[k] * N[k]; sw += W[k]; }
  for (const k in N) N[k] = Math.round(N[k] * 100) / 100;
  return { s: sw ? Math.round(100 * s / sw) : null, N, ad: adHeavy };
}

async function pool(list, n, fn) {
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } }));
  return out;
}

export default async (req) => {
  if (req.method !== 'POST') return ok({ err: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return ok({ err: 'bad json' }, 400); }
  if (body && body.probe) return ok({ srcs: srcs() });
  const places = (Array.isArray(body && body.places) ? body.places : []).slice(0, 10)
    .map(p => ({ id: String(p && p.id || ''), n: String(p && p.n || '').slice(0, 60), a: String(p && p.a || '').slice(0, 120), x: +p.x, y: +p.y }))
    .filter(p => /^\d{1,15}$/.test(p.id) && p.n);
  if (!places.length) return ok({ srcs: srcs(), res: {} });
  const sc = scoreStore(), sg = sig(), now = Date.now();
  // 저장해 둔 결과(7일, 연결된 자료가 같을 때만)를 먼저 쓰고 나머지만 새로 셈
  const cached = await Promise.all(places.map(p => sc.get('p:' + p.id, { type: 'json' }).catch(() => null)));
  const todo = places.filter((p, i) => !(cached[i] && cached[i].sg === sg && now - cached[i].t < TTL));
  const fresh = await pool(todo, 3, onePlace);
  const tr = await trends(todo);
  const partsById = {};
  places.forEach((p, i) => { if (cached[i] && cached[i].sg === sg && now - cached[i].t < TTL) partsById[p.id] = cached[i].parts; });
  await Promise.all(todo.map(async (p, i) => {
    const parts = fresh[i] || {};
    if (tr[p.id]) parts.trend = tr[p.id];
    partsById[p.id] = parts;
    await sc.set('p:' + p.id, JSON.stringify({ t: now, sg, parts })).catch(() => {});
  }));
  const o = await ours().catch(() => ({}));
  const res = {};
  for (const p of places) { const parts = partsById[p.id] || {}; const r = scoreOf(parts, o[p.id] || {}); res[p.id] = { ...r, parts, our: o[p.id] || null }; }
  return ok({ srcs: srcs(), res });
};
