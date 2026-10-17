// 말로 찾기: 동네 이름 뽑기·찾기(같은 이름 동네·범위), 소리 나는 대로 받아쓴 이름 되돌리기
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, plain } from './harness.mjs';

const nm = x => String(x || '').replace(/\s+/g, '').toLowerCase();
const A = (full, y, x) => { const [r1, r2, r3] = full.split(' '); return { address_name: full, y: String(y), x: String(x), address: { region_1depth_name: r1, region_2depth_name: r2 || '', region_3depth_name: r3 || '' } }; };
const DB = {
  '연지동': [A('서울 종로구 연지동', 37.574, 127.002), A('부산 부산진구 연지동', 35.171, 129.053)],
  '송정동': [A('부산 해운대구 송정동', 35.18, 129.2), A('부산 강서구 송정동', 35.09, 128.86), A('광주 광산구 송정동', 35.13, 126.79)],
  '명동': [A('서울 중구 명동', 37.56, 126.98)],
  '제주': [A('제주특별자치도', 33.4, 126.5), A('제주특별자치도 제주시', 33.5, 126.53)],
};
function mk(scope) {
  const kakao = { maps: { services: { Status: { OK: 'OK' }, Geocoder: function () { this.addressSearch = (t, cb) => { const d = DB[t] || []; cb(d, d.length ? 'OK' : 'ZERO'); }; } } } };
  const ps = { keywordSearch: (t, cb) => { const d = t === '신평역' ? [{ place_name: '신평역 부산1호선', category_group_code: 'SW8', category_name: '교통,수송 > 지하철', y: '35.0955', x: '128.9606', address_name: '부산 사하구 신평동 590' }] : []; cb(d, d.length ? 'OK' : 'ZERO'); } };
  return load(['AREA_TAIL', 'AREA_CAT', 'SPOKEN', 'spokenOf', 'AREA_FILL', 'cleanArea', 'AREA_FIX', 'resolveArea', 'fin0', 'AREA_SCOPES', 'SCOPE_RE', 'areaScope', 'scopeName', 'distanceM', 'refLL'],
    { nm, kakao, ps, searchCenter: null, lastPos: { lat: 35.08, lng: 128.88 }, lsGet: (k, d) => k === 'areaScope' ? scope : d });
}
const show = r => r.area ? '하나 ' + r.area.label : r.multi ? (r.outside ? '밖 ' : '여럿 ') + r.list.map(a => a.label).join(' | ') : '없음';

test('동네 이름만 뽑기', () => {
  const { cleanArea } = mk('부산');
  assert.equal(cleanArea('부산의 연지동이라는 동네를'), '부산 연지동');
  assert.equal(cleanArea('하단동에서'), '하단동');
  assert.equal(cleanArea('부산진구 연지동 근처'), '부산진구 연지동');
});

test('범위(기본 부산) 안에서 찾고, 같은 이름이 여러 곳이면 물음', async () => {
  const { resolveArea } = mk('부산');
  assert.equal(show(await resolveArea('연지동')), '하나 부산 부산진구 연지동');          // 서울 연지동으로 가던 것
  assert.equal(show(await resolveArea('부산의 연지동이라는 동네')), '하나 부산 부산진구 연지동');   // 구가 빠져도
  assert.equal(show(await resolveArea('서울 연지동')), '하나 서울 종로구 연지동');       // 말한 시·도가 먼저
  assert.equal(show(await resolveArea('송정동')), '여럿 부산 강서구 송정동 | 부산 해운대구 송정동');   // 가까운 순
  assert.equal(show(await resolveArea('명동')), '밖 서울 중구 명동');                    // 범위 밖에만 → 보여 주고 물음
  assert.equal(show(await resolveArea('제주')), '하나 제주특별자치도');                  // 시·도만 말하면 도 전체
  assert.equal(show(await resolveArea('신평역')), '하나 신평역 · 부산 사하구');           // 역 이름
});

test('전국이면 같은 이름 동네를 다 보여 주고 물음', async () => {
  const { resolveArea } = mk('all');
  assert.equal(show(await resolveArea('연지동')), '여럿 부산 부산진구 연지동 | 서울 종로구 연지동');
});

test('고른 동네는 10분 동안 기억', async () => {
  const { resolveArea, AREA_FIX } = mk('all');
  const r = await resolveArea('연지동');
  AREA_FIX[nm('연지동')] = { a: r.list[1], t: Date.now() };
  assert.equal(show(await resolveArea('연지동')), '하나 서울 종로구 연지동');
  assert.equal(show(await resolveArea('부산 연지동')), '하나 부산 부산진구 연지동');   // 다른 시·도를 말하면 기억 안 씀
});

test('소리 나는 대로 받아쓴 이름 되돌리기', () => {
  const { soundAlikes } = load(['soundAlikes']);
  assert.deepEqual(plain(soundAlikes('심평역')), ['신평역']);
  assert.ok(soundAlikes('정지깐').includes('정짓간'));
  assert.ok(soundAlikes('종노').includes('종로'));
  assert.deepEqual(plain(soundAlikes('서면역')), []);
});
