// 핀볼 지도 — 여행 사진 저장소 (Netlify Blobs 'pinb-photos')
// 앱에서 긴 변 1600px·300KB 안팎으로 줄인 JPEG와 썸네일만 받음 (원본은 폰에 그대로)
//   POST {id, t:0|1, b64}  → 저장 (t=1 썸네일)  · JPEG만, 본 사진 700KB·썸네일 120KB 이하
//   POST {id, del:true}    → 삭제 (본 사진 + 썸네일)
//   GET  ?id=...&t=1       → 사진 보기 (주소가 바뀌지 않으니 오래 캐시)
// 사진 번호(id)는 앱이 만든 추측하기 어려운 20자리라서, 번호를 아는 사람(같은 여행방)만 볼 수 있음
import { getStore } from '@netlify/blobs';

const ID = /^[a-z0-9]{12,40}$/;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
function store() {
  return globalThis.__pinbPhotoStore || getStore({ name: 'pinb-photos', consistency: 'strong' });
}

export default async (req) => {
  const st = store();
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const id = u.searchParams.get('id') || '', t = u.searchParams.get('t') === '1';
    if (!ID.test(id)) return json({ err: 'bad id' }, 400);
    const b = await st.get((t ? 't:' : 'p:') + id, { type: 'arrayBuffer' });
    if (!b) return json({ err: 'not found' }, 404);
    return new Response(b, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } });
  }
  if (req.method !== 'POST') return json({ err: 'POST or GET only' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ err: 'bad json' }, 400); }
  const id = String((body && body.id) || '');
  if (!ID.test(id)) return json({ err: 'bad id' }, 400);
  if (body.del) {
    await st.delete('p:' + id); await st.delete('t:' + id);
    return json({ ok: true });
  }
  const t = body.t === 1 || body.t === true;
  const buf = Buffer.from(String(body.b64 || ''), 'base64');
  if (buf.length < 100 || buf.length > (t ? 120e3 : 700e3)) return json({ err: 'size' }, 413);
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return json({ err: 'jpeg only' }, 415);
  try {
    await st.set((t ? 't:' : 'p:') + id, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  } catch { return json({ err: 'save failed' }, 503); }
  return json({ ok: true });
};
