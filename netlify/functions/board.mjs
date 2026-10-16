// 핀볼 지도 — ❓ 도움말 페이지의 🎉 축제 · ✉️ 건의 · 📢 공지 (AI 없음, 무료)
// POST {action, ...}
//   fest {lat?, lng?, r?(km), days?}  → {items:[{id,t,a,s,e,x,y,img,big,tel,d?}], at, total}
//                                       관광공사 TourAPI 행사정보(searchFestival2)를 6시간마다 한 번 받아 Blobs에 보관하고 걸러서 돌려줌
//   festInfo {id}                     → {info:{ov, home, place, time, fee, tel, host, age}}   detailCommon2 + detailIntro2 (7일 보관)
//   notices                           → {items:[{id, at, title, body, pin}]}    누구나 읽기
//   notice {email, token, lab, op:'add'|'del', title, body, pin, id}            마스터만 쓰기·지우기
//   suggest {msg, kind, nick, from, ver, ua}  → {ok:1}                          누구나 (같은 곳에서 하루 10건까지)
//   suggests / sgDel {email, token, lab, id}                                     마스터만 보기·지우기
// 키: TOUR_KEY (② 종합 점수와 같은 공공데이터포털 TourAPI 일반 인증키). 없으면 축제만 {err:'nokey'}.
// 메일 알림은 앱이 Netlify Forms(무료)로 같이 보냄 — 여기 저장분은 메일이 안 와도 남는 사본.
import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const ENV = k => String(process.env[k] || '').trim();
const sha = x => createHash('sha256').update(String(x)).digest('hex');
const store = name => (globalThis.__pinbStores && globalThis.__pinbStores[name]) || getStore({ name, consistency: 'strong' });   // 시험할 땐 가짜 저장소
const MASTER = 'yangdlre@gmail.com';
const KST = 9 * 36e5;
const ymd = t => new Date(t + KST).toISOString().slice(0, 10).replace(/-/g, '');
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };
const dec = s => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const plain = (s, n) => clip(dec(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'), n);
const https = u => /^https?:\/\//i.test(String(u || '')) ? String(u).replace(/^http:/i, 'https:') : '';
const hrefOf = s => { const m = String(s || '').match(/href\s*=\s*["']?([^"' >]+)/i) || String(s || '').match(/(https?:\/\/[^\s"'<>]+|www\.[^\s"'<>]+)/i); return m ? (/^www\./i.test(m[1]) ? 'https://' + m[1] : m[1]) : ''; };
function dist(a, b, c, d) {   // m
  const R = 6371e3, r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
  return Math.round(Math.sqrt(x * x + y * y) * R);
}

// ---------- 관광공사 TourAPI ----------
const TOUR = 'https://apis.data.go.kr/B551011/KorService2/';
const tourKey = () => { const k = ENV('TOUR_KEY'); return /%[0-9A-F]{2}/i.test(k) ? k : encodeURIComponent(k); };   // Encoding 값을 넣어도 동작
const tq = (op, q) => `${TOUR}${op}?serviceKey=${tourKey()}&MobileOS=ETC&MobileApp=pinbmap&_type=json&${q}`;
async function getJSON(url, ms = 7000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) return null; const s = await r.text(); try { return JSON.parse(s); } catch { return null; } }   // 키 오류면 XML이 옴
  catch { return null; } finally { clearTimeout(t); }
}
const bodyOf = d => (d && d.response && d.response.body) || null;
const itemsOf = b => (b && b.items && b.items.item ? [].concat(b.items.item) : []);
const slim = x => ({
  id: String(x.contentid || ''), t: clip(dec(x.title), 80), a: clip(dec([x.addr1, x.addr2].filter(Boolean).join(' ')), 120),
  s: String(x.eventstartdate || '').slice(0, 8), e: String(x.eventenddate || '').slice(0, 8),
  x: +x.mapx || 0, y: +x.mapy || 0, img: https(x.firstimage2 || x.firstimage), big: https(x.firstimage), tel: clip(dec(x.tel), 40),
});
const PAGE = 500, FEST_TTL = 6 * 36e5;
// 지난 60일 안에 시작한 것부터 받아 끝난 것만 뺌 (시작일 기준이든 종료일 기준이든 진행 중인 축제가 빠지지 않게)
async function fetchFest(now) {
  const q = p => tq('searchFestival2', `numOfRows=${PAGE}&pageNo=${p}&arrange=A&eventStartDate=${ymd(now - 60 * 864e5)}`);
  const b1 = bodyOf(await getJSON(q(1)));
  if (!b1) return null;
  const pages = Math.min(8, Math.ceil((+b1.totalCount || 0) / PAGE));
  const all = itemsOf(b1);
  if (pages > 1) for (const d of await Promise.all(Array.from({ length: pages - 1 }, (_, i) => getJSON(q(i + 2))))) all.push(...itemsOf(bodyOf(d)));
  const today = ymd(now), seen = new Set();
  return all.map(slim).filter(x => x.id && /^\d{8}$/.test(x.e) && x.e >= today && !seen.has(x.id) && seen.add(x.id));
}
async function festAll(st, now) {
  const cur = await st.get('fest:all', { type: 'json' }).catch(() => null);
  if (cur && Array.isArray(cur.items) && now - (cur.at || 0) < FEST_TTL) return cur;
  if (cur && now - (cur.failAt || 0) < 30 * 6e4) return Array.isArray(cur.items) ? { ...cur, stale: true } : null;   // 방금 실패했으면 30분은 다시 안 부름
  const items = await fetchFest(now);
  if (items) { const v = { at: now, items }; await st.set('fest:all', JSON.stringify(v)).catch(() => {}); return v; }
  await st.set('fest:all', JSON.stringify({ ...(cur || {}), failAt: now })).catch(() => {});
  return cur && Array.isArray(cur.items) ? { ...cur, stale: true } : null;   // 받기 실패면 예전 것이라도
}
async function fest(body, st) {
  if (!ENV('TOUR_KEY')) return ok({ err: 'nokey' });
  const now = Date.now(), all = await festAll(st, now);
  if (!all) return ok({ err: 'tour' }, 502);
  const today = ymd(now), days = Math.min(120, Math.max(0, +body.days || 30)), until = ymd(now + days * 864e5);
  const lat = +body.lat, lng = +body.lng, r = Math.min(600, Math.max(0, +body.r || 0));
  let list = all.items.filter(x => x.e >= today && x.s <= until);
  if (r && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 1) list = list.filter(x => x.x && x.y).map(x => ({ ...x, d: dist(lat, lng, x.y, x.x) })).filter(x => x.d <= r * 1000);
  // 진행 중인 것 먼저(곧 끝나는 순), 그다음 시작일 순, 같으면 가까운 순
  const on = x => x.s <= today;
  list.sort((a, b) => (on(b) - on(a)) || (on(a) ? a.e.localeCompare(b.e) : a.s.localeCompare(b.s)) || ((a.d || 0) - (b.d || 0)));
  return ok({ items: list.slice(0, 80), total: list.length, at: all.at, stale: !!all.stale });
}
async function festInfo(body, st) {
  const id = String(body.id || '');
  if (!/^\d{1,12}$/.test(id)) return ok({ err: 'bad id' }, 400);
  const key = 'fi:' + id, cur = await st.get(key, { type: 'json' }).catch(() => null);
  if (cur && Date.now() - (cur.at || 0) < 7 * 864e5) return ok({ info: cur.info });
  if (!ENV('TOUR_KEY')) return ok({ err: 'nokey' });
  const [c, i] = await Promise.all([getJSON(tq('detailCommon2', `contentId=${id}`)), getJSON(tq('detailIntro2', `contentId=${id}&contentTypeId=15`))]);
  const ci = itemsOf(bodyOf(c))[0], ii = itemsOf(bodyOf(i))[0];
  if (!ci && !ii) return cur ? ok({ info: cur.info }) : ok({ err: 'tour' }, 502);
  const a = ci || {}, b = ii || {};
  const info = {
    ov: plain(a.overview, 700), home: https(hrefOf(b.eventhomepage) || hrefOf(a.homepage)) || '',
    place: plain(b.eventplace, 80), time: plain(b.playtime, 120), fee: plain(b.usetimefestival, 120),
    tel: plain(b.sponsor1tel || a.tel, 40), host: plain(b.sponsor1, 60), age: plain(b.agelimit, 40),
  };
  await st.set(key, JSON.stringify({ at: Date.now(), info })).catch(() => {});
  return ok({ info });
}

// ---------- 계정 확인 (sync 함수와 같은 계정 자료를 읽기만 함) ----------
async function isMaster(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (email !== MASTER || String(body.lab || '') !== '5555') return false;
  const rec = await store('pinb-rooms').get('acct:' + sha('pinb|' + email).slice(0, 40), { type: 'json' }).catch(() => null);
  if (!rec || !Array.isArray(rec.tokens)) return false;
  const th = Buffer.from(sha(String(body.token || '')), 'hex');
  return rec.tokens.some(x => { try { const b = Buffer.from(String(x && x.t || ''), 'hex'); return b.length === th.length && timingSafeEqual(b, th); } catch { return false; } });
}

// ---------- 📢 공지 ----------
const cleanNotice = n => ({ id: String(n.id), at: +n.at || 0, title: clip(n.title, 60), body: clip(n.body, 2000), pin: !!n.pin });
const sortN = a => a.sort((x, y) => (y.pin - x.pin) || (y.at - x.at));
async function notices(st) {
  const v = await st.get('notices', { type: 'json' }).catch(() => null);
  return Array.isArray(v) ? sortN(v.map(cleanNotice)) : [];
}
async function notice(body, st) {
  if (!(await isMaster(body))) return ok({ err: 'not master' }, 403);
  let list = await notices(st);
  if (body.op === 'del') list = list.filter(n => n.id !== String(body.id || ''));
  else {
    const title = clip(body.title, 60), text = clip(body.body, 2000);
    if (!title && !text) return ok({ err: 'empty' }, 400);
    const id = String(body.id || '');
    const old = id && list.find(n => n.id === id);
    if (old) Object.assign(old, { title, body: text, pin: !!body.pin });   // 고치기 (날짜는 그대로)
    else list.unshift(cleanNotice({ id: Date.now().toString(36), at: Date.now(), title, body: text, pin: !!body.pin }));
  }
  list = sortN(list).slice(0, 50);
  await st.set('notices', JSON.stringify(list));
  return ok({ items: list });
}

// ---------- ✉️ 건의 ----------
const KINDS = ['건의', '오류', '칭찬', '기타'];
async function suggest(body, st, req) {
  const msg = clip(body.msg, 1000);
  if (msg.length < 2) return ok({ err: 'empty' }, 400);
  const ip = (req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const lk = 'sgl:' + sha(ip + '|' + ymd(Date.now())).slice(0, 24);
  const n = +((await st.get(lk).catch(() => null)) || 0);
  if (n >= 10) return ok({ err: 'limit' }, 429);
  await st.set(lk, String(n + 1)).catch(() => {});
  const from = clip(body.from, 100).toLowerCase();
  const rec = { at: Date.now(), kind: KINDS.includes(body.kind) ? body.kind : '건의', msg, nick: clip(body.nick, 20), from: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) ? from : '', ver: clip(body.ver, 20), ua: clip(body.ua, 120) };
  const id = rec.at.toString(36) + Math.random().toString(36).slice(2, 6);
  await st.set('sg:' + id, JSON.stringify(rec));
  return ok({ ok: 1, id });
}
async function suggests(body, st) {
  if (!(await isMaster(body))) return ok({ err: 'not master' }, 403);
  if (body.action === 'sgDel') {
    const id = String(body.id || '');
    if (!/^[a-z0-9]{6,20}$/.test(id)) return ok({ err: 'bad id' }, 400);
    await st.delete('sg:' + id);
  }
  const { blobs } = await st.list({ prefix: 'sg:' });
  const keys = blobs.map(b => b.key).sort().reverse().slice(0, 200);
  const items = (await Promise.all(keys.map(async k => { const v = await st.get(k, { type: 'json' }).catch(() => null); return v ? { id: k.slice(3), ...v } : null; }))).filter(Boolean);
  items.sort((a, b) => b.at - a.at);
  return ok({ items, total: blobs.length });
}

export default async (req) => {
  if (req.method !== 'POST') return ok({ err: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return ok({ err: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return ok({ err: 'bad json' }, 400);
  const st = store('pinb-board');
  try {
    switch (body.action) {
      case 'fest': return await fest(body, st);
      case 'festInfo': return await festInfo(body, st);
      case 'notices': return ok({ items: await notices(st) });
      case 'notice': return await notice(body, st);
      case 'suggest': return await suggest(body, st, req);
      case 'suggests': case 'sgDel': return await suggests(body, st);
      default: return ok({ err: 'bad action' }, 400);
    }
  } catch (e) { return ok({ err: 'store', detail: String(e && e.message || e).slice(0, 120) }, 503); }
};
