// 핀볼 지도 — 동기화 함수 (Netlify Blobs 저장)
// ① 여행방  : POST {room, nick, create?, doc:{trip,picks,items,todos,exps}}
//             일행이 함께 보는 일정표·담아둔 곳·할일·경비
// ② 내 설정  : POST {kind:'set', room:<설정코드>, create?, kv:{키:{v,upd}}}
//             내 폰·노트북끼리만 맞추는 시작위치·테마 등 개인 설정
// 서버에 있는 것과 보낸 것을 "항목별 최신 수정 우선"으로 합쳐 저장하고, 합친 결과를 돌려줍니다.
import { getStore } from '@netlify/blobs';

const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const ARR = ['picks', 'items', 'todos', 'exps'];
const MAX_BYTES = 450 * 1024;

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

export default async (req) => {
  if (req.method !== 'POST') return ok({ err: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return ok({ err: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return ok({ err: 'bad json' }, 400);
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
