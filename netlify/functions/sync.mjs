// 핀볼 지도 — 여행방(친구와 일정표·할일 공유) 동기화
// POST /.netlify/functions/sync  {room, nick, create?, doc:{trip,picks,items,todos}}
// 서버에 있는 방 내용과 보낸 내용을 "항목별 최신 수정 우선"으로 합친 뒤 저장하고, 합친 결과를 돌려줍니다.
// 삭제는 지우지 않고 del 표시로 남겨서 다른 사람 폰에서도 지워지게 합니다.
import { getStore } from '@netlify/blobs';

const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const ARR = ['picks', 'items', 'todos'];
const MAX_BYTES = 400 * 1024;

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
function cleanDoc(d) {
  const o = { trip: d && typeof d.trip === 'object' ? d.trip : null };
  for (const k of ARR) o[k] = Array.isArray(d && d[k]) ? d[k].filter(x => x && typeof x.uid === 'string').slice(0, 1000) : [];
  return o;
}
function store() {
  return globalThis.__pinbStore || getStore({ name: 'pinb-rooms', consistency: 'strong' });
}

export default async (req) => {
  if (req.method !== 'POST') return ok({ err: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return ok({ err: 'bad json' }, 400); }
  const room = String(body.room || '').toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(room)) return ok({ err: 'bad room' }, 400);
  const nick = String(body.nick || '').slice(0, 20) || '익명';
  const mine = cleanDoc(body.doc || {});
  const st = store();

  // 동시에 두 사람이 저장해도 덮어쓰지 않도록, 읽은 뒤 바뀌었으면 다시 합쳐서 저장 (최대 4번)
  for (let tries = 0; tries < 4; tries++) {
    const cur = await st.getWithMetadata(room, { type: 'json' });
    if (!cur) {
      if (!body.create) return ok({ err: 'no room' }, 404);
      const rec = { doc: mine, members: { [nick]: Date.now() }, created: Date.now() };
      const w = await st.setJSON(room, rec, { onlyIfNew: true });
      if (w && w.modified === false) continue;
      return ok({ doc: rec.doc, members: rec.members });
    }
    if (body.create) return ok({ err: 'exists' }, 409);
    const data = cur.data || {};
    const merged = mergeDoc(cleanDoc(data.doc || {}), mine);
    const members = { ...(data.members || {}), [nick]: Date.now() };
    const rec = { ...data, doc: merged, members };
    if (JSON.stringify(rec).length > MAX_BYTES) return ok({ err: 'too big' }, 413);
    const w = await st.setJSON(room, rec, { onlyIfMatch: cur.etag });
    if (w && w.modified === false) continue;
    return ok({ doc: merged, members });
  }
  return ok({ err: 'busy' }, 503);
};
