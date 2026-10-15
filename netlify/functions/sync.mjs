// 핀볼 지도 — 동기화 함수 (Netlify Blobs 저장)
// ① 여행방  : POST {room, nick, create?, doc:{trip,picks,items,todos,exps,photos}}
//             일행이 함께 보는 일정표·담아둔 곳·할일·경비
// ② 내 설정  : POST {kind:'set', room:<설정코드>, create?, kv:{키:{v,upd}}}
//             내 폰·노트북끼리만 맞추는 시작위치·테마 등 개인 설정
// ③ 계정    : POST {kind:'acct', action:'signup'|'login'|'sync'|'logout'|'delete'|'share'|'admin', email, pin|token, kv, trips, saved, inboxDel, open}
//             open:1 = 앱을 새로 연 뒤 첫 맞추기 → 방문 횟수 +1 (stat:… 키에 따로 저장, 계정 자료는 그대로)
//             admin: 마스터 계정만 — 가입자 수·이메일·방문 횟수·마지막 접속
//             share: {to:[친구 이메일], trip:{code,name,start,days}, nick} → 친구 계정의 '공유받은 여행(inbox)'에 넣음
//             이메일 + 숫자 4자리로 내 설정·여행 보관함·📌 보류 맛집을 어느 기기에서나 불러오기 (중요 정보용 아님)
// 서버에 있는 것과 보낸 것을 "항목별 최신 수정 우선"으로 합쳐 저장하고, 합친 결과를 돌려줍니다.
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const ARR = ['picks', 'items', 'todos', 'exps', 'photos'];   // photos: 여행 사진 목록(사진 자체는 photo 함수에 따로 저장)
const MAX_BYTES = 450 * 1024;
const ACCT_MAX = 3 * 1024 * 1024;   // 계정: 보관함 여행이 쌓이고 사진 목록까지 실리므로 넉넉히 (사진 파일 자체는 photo 함수에 따로)

export function mergeArr(a = [], b = []) {
  const m = new Map();
  for (const x of a) if (x && x.uid) m.set(x.uid, x);
  for (const x of b) {
    if (!x || !x.uid) continue;
    const y = m.get(x.uid);
    if (!y || (x.upd || 0) > (y.upd || 0)) m.set(x.uid, x);
  }
  return [...m.values()];
}
export function mergeDoc(a = {}, b = {}) {
  const out = {};
  for (const k of ARR) out[k] = mergeArr(a[k], b[k]);
  const ta = a.trip || null, tb = b.trip || null;
  out.trip = !ta ? tb : !tb ? ta : ((tb.upd || 0) > (ta.upd || 0) ? tb : ta);
  return out;
}
export function mergeKV(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, x] of Object.entries(b || {})) {
    if (!x || typeof x !== 'object') continue;
    if (!out[k] || (x.upd || 0) > (out[k].upd || 0)) out[k] = x;
  }
  return out;
}
function cleanDoc(d) {
  const o = { trip: d && typeof d.trip === 'object' ? d.trip : null };
  // 항목 번호는 영문·숫자만, 수정시각은 숫자만 허용 (이상한 값이 친구 화면에 들어가지 않게)
  // 수정시각은 숫자로 맞추고(문자열 비교 방지) 하루 넘는 미래 값은 지금으로, 개수 제한 시 최신 것부터 남김
  const lim = Date.now() + 864e5;
  for (const k of ARR) o[k] = Array.isArray(d && d[k]) ? d[k].filter(x => x && typeof x === 'object' && typeof x.uid === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x.uid) && (x.upd === undefined || Number.isFinite(+x.upd)))
    .map(x => ({ ...x, upd: Math.min(+x.upd || 0, lim) })).sort((a, b) => b.upd - a.upd).slice(0, 1500) : [];
  return o;
}
// 📌 보류 맛집: 여행과 상관없이 계정에 남는 장소 목록 (항목별 최신 수정 우선, 지운 것은 del 표시로 남김)
export function cleanSaved(a) {
  if (!Array.isArray(a)) return [];
  const lim = Date.now() + 864e5;
  return a.filter(x => x && typeof x === 'object' && typeof x.uid === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x.uid) && (x.del || (x.p && typeof x.p === 'object')))
    .map(x => ({ ...x, upd: Math.min(+x.upd || 0, lim) })).sort((a, b) => b.upd - a.upd).slice(0, 1000);
}
// 📒 가계부: 내 기기끼리만 맞추는 개인 지출 기록 (항목별 최신 수정 우선, 최대 5000건)
export function cleanBook(a) {
  if (!Array.isArray(a)) return [];
  const lim = Date.now() + 864e5;
  return a.filter(x => x && typeof x === 'object' && typeof x.uid === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x.uid) && JSON.stringify(x).length < 800)
    .map(x => ({ ...x, upd: Math.min(+x.upd || 0, lim) })).sort((a, b) => b.upd - a.upd).slice(0, 5000);
}
const bookSig = a => `${a.length}:${a.reduce((m, x) => Math.max(m, +x.upd || 0), 0)}`;
function cleanKV(kv) {
  const o = {};
  if (kv && typeof kv === 'object') for (const [k, x] of Object.entries(kv).slice(0, 40)) if (/^[a-zA-Z]{1,20}$/.test(k) && x && typeof x === 'object') o[k] = { v: x.v, upd: Math.min(+x.upd || 0, Date.now() + 864e5) };
  return o;
}
// 주의: @netlify/blobs 10.0.x 의 setJSON()은 onlyIfMatch/onlyIfNew 조건을 서버에 넘기지 않음(동시 저장 시 덮어씀).
// 그래서 조건이 제대로 전달되는 set()에 JSON 글자를 넣어 저장하고,
// 저장 서버 오류인데 성공처럼 돌아오는 경우(etag 없음)는 실패로 처리한다.
async function put(st, key, rec, cond) {
  const w = await st.set(key, JSON.stringify(rec), cond);
  if (w && w.modified === false) return 'conflict';
  if (!w || !w.etag) return 'fail';
  return 'ok';
}
function store() {
  return globalThis.__pinbStore || getStore({ name: 'pinb-rooms', consistency: 'strong' });
}
// 🎤 말로 찾기 AI 키 저장소 (ai 함수) — 탈퇴할 때 같이 지움
function aiStore() {
  return (globalThis.__pinbStores && globalThis.__pinbStores['pinb-ai']) || getStore({ name: 'pinb-ai', consistency: 'strong' });
}

// ---------- 계정 ----------
const MASTER = 'yangdlre@gmail.com';
// 방문 기록: 계정 자료(acct:…)와 따로 stat:… 에 둠 (예전 버전 서버가 계정 자료를 저장해도 지워지지 않게)
async function bumpStat(st, key, email, created, inc) {
  try {
    const sk = 'stat:' + key.slice(5), now = Date.now();
    const cur = (await st.get(sk, { type: 'json' })) || {};
    await st.set(sk, JSON.stringify({ email, created: cur.created || created || now, n: (cur.n || 0) + (inc ? 1 : 0), last: inc ? now : (cur.last || now), seen: now }));
  } catch { /* 방문 기록 실패는 무시 */ }
}
async function adminList(st) {
  const { blobs } = await st.list({ prefix: 'acct:' });
  const sl = await st.list({ prefix: 'stat:' });
  const stats = {};
  await Promise.all(sl.blobs.map(async b => { const v = await st.get(b.key, { type: 'json' }); if (v) stats[b.key.slice(5)] = v; }));
  const rows = await Promise.all(blobs.map(async b => {
    const h = b.key.slice(5), s = stats[h];
    if (s) return { email: s.email || null, n: s.n || 0, last: s.last || 0, created: s.created || 0 };
    const rec = await st.get(b.key, { type: 'json' }).catch(() => null);
    return { email: null, n: 0, last: 0, created: (rec && rec.created) || 0 };
  }));
  rows.sort((a, b) => (b.last || 0) - (a.last || 0) || (b.created || 0) - (a.created || 0));
  return ok({ total: blobs.length, known: rows.filter(r => r.email).length, rows });
}
const sha = (x) => createHash('sha256').update(String(x)).digest('hex');
const pinHash = (pin, salt) => scryptSync(String(pin), salt, 32).toString('hex');
function pinOK(pin, rec) {
  if (!/^\d{4}$/.test(String(pin || '')) || !rec.salt || !rec.hash) return false;
  const a = Buffer.from(pinHash(pin, rec.salt), 'hex'), b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function cleanTrips(t) {
  const o = {};
  if (!t || typeof t !== 'object' || Array.isArray(t)) return o;
  const lim = Date.now() + 864e5;
  for (const [k, e] of Object.entries(t).slice(0, 80)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(k) || !e || typeof e !== 'object') continue;
    const at = Math.min(+e.at || 0, lim);
    if (e.del) { o[k] = { del: true, at }; continue; }
    o[k] = { code: typeof e.code === 'string' && /^[A-Z0-9]{6,12}$/.test(e.code) ? e.code : null, at, data: cleanDoc(e.data || {}) };
  }
  return o;
}
export function mergeTrips(a = {}, b = {}) {
  const o = { ...a };
  for (const [k, e] of Object.entries(b)) {
    const c = o[k];
    if (!c) { o[k] = e; continue; }
    if (e.del || c.del) { if ((e.at || 0) > (c.at || 0)) o[k] = e; continue; }
    o[k] = { code: e.code || c.code || null, at: Math.max(c.at || 0, e.at || 0), data: mergeDoc(c.data || {}, e.data || {}) };
  }
  return o;
}
// 👤 아이디로 공유: 친구 계정의 inbox 에 {방코드: 보낸 사람·여행 이름} 을 넣음 (친구가 열면 그 방으로 들어감)
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
async function shareTrip(st, from, body) {
  const t = body.trip || {};
  const code = String(t.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return ok({ err: 'bad room' }, 400);
  const entry = { from, nick: String(body.nick || '').slice(0, 20), name: String(t.name || '').slice(0, 30), start: /^\d{4}-\d{2}-\d{2}$/.test(t.start) ? t.start : '', days: Math.max(1, Math.min(7, Math.floor(+t.days || 1))), at: Date.now() };
  const to = [...new Set((Array.isArray(body.to) ? body.to : []).map(e => String(e || '').trim().toLowerCase()))].filter(e => EMAIL.test(e) && e !== from).slice(0, 20);
  const sent = [], missing = [], failed = [];
  for (const e of to) {
    const key = 'acct:' + sha('pinb|' + e).slice(0, 40);
    let done = false;
    for (let i = 0; i < 4 && !done; i++) {
      const cur = await st.getWithMetadata(key, { type: 'json' });
      if (!cur) { missing.push(e); done = true; break; }
      const rec = { ...(cur.data || {}) };
      const inbox = { ...(rec.inbox || {}) };
      inbox[code] = entry;
      rec.inbox = Object.fromEntries(Object.entries(inbox).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 50));
      const w = await put(st, key, rec, { onlyIfMatch: cur.etag });
      if (w === 'ok') { sent.push(e); done = true; } else if (w === 'fail') break;
    }
    if (!done) failed.push(e);
  }
  return ok({ sent, missing, failed });
}
async function acct(body, st) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return ok({ err: 'bad email' }, 400);
  const key = 'acct:' + sha('pinb|' + email).slice(0, 40);
  const act = body.action, now = Date.now();
  for (let tries = 0; tries < 4; tries++) {
    const cur = await st.getWithMetadata(key, { type: 'json' });
    if (act === 'signup') {
      if (!/^\d{4}$/.test(String(body.pin || ''))) return ok({ err: 'bad pin' }, 400);
      if (cur) return ok({ err: 'exists' }, 409);
      const salt = randomBytes(16).toString('hex'), tok = randomBytes(24).toString('hex');
      const rec = { salt, hash: pinHash(body.pin, salt), fails: 0, lock: 0, tokens: [{ t: sha(tok), at: now }], kv: cleanKV(body.kv), trips: cleanTrips(body.trips), saved: cleanSaved(body.saved), book: cleanBook(body.book), created: now };
      if (Buffer.byteLength(JSON.stringify(rec)) > ACCT_MAX) return ok({ err: 'too big' }, 413);
      const w = await put(st, key, rec, { onlyIfNew: true });
      if (w === 'conflict') continue;
      if (w === 'fail') return ok({ err: 'save failed' }, 503);
      await bumpStat(st, key, email, now, true);
      return ok({ token: tok, kv: rec.kv, trips: rec.trips, saved: rec.saved });
    }
    if (!cur) return ok({ err: 'no account' }, 404);
    const rec = { ...(cur.data || {}) };
    rec.tokens = Array.isArray(rec.tokens) ? rec.tokens : [];
    let newTok = null;
    if (act === 'login') {
      if ((rec.lock || 0) > now) return ok({ err: 'locked', until: rec.lock }, 429);
      if (!pinOK(body.pin, rec)) {
        // 50번 틀리면 15분 잠금 (숫자 4자리라 마구 맞혀보기 방지 — 쓰기 편하게 넉넉히)
        rec.fails = (rec.fails || 0) + 1;
        if (rec.fails >= 50) { rec.fails = 0; rec.lock = now + 15 * 60e3; }
        const w = await put(st, key, rec, { onlyIfMatch: cur.etag });
        if (w === 'conflict') continue;
        return ok({ err: rec.lock > now ? 'locked' : 'wrong pin', left: rec.lock > now ? 0 : 50 - rec.fails }, 401);
      }
      rec.fails = 0; rec.lock = 0;
      newTok = randomBytes(24).toString('hex');
      rec.tokens = [...rec.tokens.slice(-9), { t: sha(newTok), at: now }];
    } else if (act === 'sync' || act === 'logout' || act === 'delete' || act === 'share' || act === 'admin') {
      const th = sha(String(body.token || ''));
      if (!rec.tokens.some(x => x && x.t === th)) return ok({ err: 'bad token' }, 401);
      if (act === 'admin') return email === MASTER && String(body.lab || '') === '5555' ? adminList(st) : ok({ err: 'not master' }, 403);
      if (act === 'share') return shareTrip(st, email, body);
      if (act === 'delete') { await st.delete(key); await st.delete('stat:' + key.slice(5)).catch(() => {});
        try { const h = key.slice(5), ai = aiStore();   // AI 키도 지움 (못 지워도 ai 함수가 가입 세대로 막음)
          await Promise.all(['k:' + h, 'k:' + h + ':gemini', 'k:' + h + ':groq'].map(k => ai.delete(k).catch(() => {}))); } catch { /* 무시 */ }
        return ok({ deleted: true }); }
      if (act === 'logout') rec.tokens = rec.tokens.filter(x => x.t !== th);
    } else return ok({ err: 'bad action' }, 400);
    if (act !== 'logout') { rec.kv = mergeKV(rec.kv || {}, cleanKV(body.kv)); rec.trips = mergeTrips(rec.trips || {}, cleanTrips(body.trips)); rec.saved = cleanSaved(mergeArr(rec.saved || [], cleanSaved(body.saved)));
      if (Array.isArray(body.book) && body.book.length) rec.book = cleanBook(mergeArr(rec.book || [], cleanBook(body.book)));
      if (rec.inbox && Array.isArray(body.inboxDel)) for (const c of body.inboxDel.slice(0, 50)) delete rec.inbox[String(c)]; }
    if (Buffer.byteLength(JSON.stringify(rec)) > ACCT_MAX) return ok({ err: 'too big' }, 413);
    const w = await put(st, key, rec, { onlyIfMatch: cur.etag });
    if (w === 'conflict') continue;
    if (w === 'fail') return ok({ err: 'save failed' }, 503);
    if (act === 'sync' || act === 'login') await bumpStat(st, key, email, rec.created, act === 'sync' && +body.open === 1);
    const bk = rec.book || [], same = typeof body.bookSig === 'string' && body.bookSig === bookSig(bk);
    return ok({ token: newTok || undefined, kv: rec.kv, trips: rec.trips, saved: rec.saved || [], inbox: rec.inbox || {}, book: same ? null : bk, bookSig: bookSig(bk) });
  }
  return ok({ err: 'busy' }, 503);
}

export default async (req) => {
  if (req.method !== 'POST') return ok({ err: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return ok({ err: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return ok({ err: 'bad json' }, 400);
  if (body.kind === 'acct') return acct(body, store());
  const code = String(body.room || '').toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return ok({ err: 'bad room' }, 400);
  const isSet = body.kind === 'set';
  const key = isSet ? 'set:' + code : code;
  const nick = String(body.nick || '').slice(0, 20) || '익명';
  const st = store();

  // 동시에 저장해도 덮어쓰지 않도록: 읽은 뒤 바뀌었으면 다시 합쳐서 저장 (최대 4번)
  for (let tries = 0; tries < 4; tries++) {
    const cur = await st.getWithMetadata(key, { type: 'json' });
    if (!cur) {
      if (!body.create) return ok({ err: 'no room' }, 404);
      const rec = isSet ? { kv: cleanKV(body.kv), created: Date.now() }
                        : { doc: cleanDoc(body.doc || {}), members: { [nick]: Date.now() }, created: Date.now() };
      if (Buffer.byteLength(JSON.stringify(rec)) > MAX_BYTES) return ok({ err: 'too big' }, 413);
      const w = await put(st, key, rec, { onlyIfNew: true });
      if (w === 'conflict') continue;
      if (w === 'fail') return ok({ err: 'save failed' }, 503);
      return ok(isSet ? { kv: rec.kv } : { doc: rec.doc, members: rec.members });
    }
    if (body.create) return ok({ err: 'exists' }, 409);
    const data = cur.data || {};
    let rec;
    if (isSet) rec = { ...data, kv: mergeKV(data.kv || {}, cleanKV(body.kv)) };
    else rec = { ...data, doc: mergeDoc(cleanDoc(data.doc || {}), cleanDoc(body.doc || {})), members: { ...(data.members || {}), [nick]: Date.now() } };
    if (Buffer.byteLength(JSON.stringify(rec)) > MAX_BYTES) return ok({ err: 'too big' }, 413);
    const w = await put(st, key, rec, { onlyIfMatch: cur.etag });
    if (w === 'conflict') continue;
    if (w === 'fail') return ok({ err: 'save failed' }, 503);
    return ok(isSet ? { kv: rec.kv } : { doc: rec.doc, members: rec.members });
  }
  return ok({ err: 'busy' }, 503);
};
