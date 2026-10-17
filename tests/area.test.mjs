// 말로 찾기: 동네 이름 뽑기·찾기(같은 이름 동네·범위), 소리 나는 대로 받아쓴 이름 되돌리기
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, plain } from './harness.mjs';

const nm = x => String(x || '').replace(/\s+/g, '').toLowerCase();
// 카카오처럼: 첫 칸 = 시·도, 끝 칸 = 동(셋 이상일 때), 가운데 = 시·구('창원시 진해구')
const A = (full, y, x) => { const p = full.split(' '), r1 = p[0], r3 = p.length > 2 ? p[p.length - 1] : '', r2 = p.length > 2 ? p.slice(1, -1).join(' ') : (p[1] || ''); return { address_name: full, y: String(y), x: String(x), address: { region_1depth_name: r1, region_2depth_name: r2 || '', region_3depth_name: r3 || '' } }; };
const DB = {
  '연지동': [A('서울 종로구 연지동', 37.574, 127.002), A('부산 부산진구 연지동', 35.171, 129.053)],
  '송정동': [A('부산 해운대구 송정동', 35.18, 129.2), A('부산 강서구 송정동', 35.09, 128.86), A('광주 광산구 송정동', 35.13, 126.79)],
  '제주': [A('제주특별자치도', 33.4, 126.5), A('제주특별자치도 제주시', 33.5, 126.53)],
  // 실제 카카오는 비슷한 글자도 줌 (10/18 폰 화면)
  '남포동': [A('부산 중구 남포동6가', 35.097, 129.034), A('부산 중구 남포동3가', 35.098, 129.03), A('부산 중구 남포동1가', 35.099, 129.026)],
  '하단': [A('부산 사하구 하단동', 35.106, 128.96), A('부산 사하구 하단1동', 35.104, 128.962), A('부산 사하구 하단2동', 35.11, 128.957)],
  '명동': [A('경남 창원시 진해구 명동', 35.13, 128.69), A('서울 중구 명동1가', 37.563, 126.985), A('서울 중구 명동2가', 37.561, 126.986)],
  '서면': [A('경북 경주시 서면', 35.83, 129.04), A('경남 남해군 서면', 34.8, 127.85), A('전남광주통합특별시 순천시 서면', 35.0, 127.4), A('경북 울진군 금강송면', 36.9, 129.2), A('세종특별자치시 연서면', 36.6, 127.2), A('강원특별자치도 영월군 한반도면', 37.2, 128.3)],
};
const KW = {
  '신평역': [{ place_name: '신평역 부산1호선', category_group_code: 'SW8', category_name: '교통,수송 > 지하철', y: '35.0955', x: '128.9606', address_name: '부산 사하구 신평동 590' }],
  '서면': [{ place_name: '서면역 부산1호선', category_group_code: 'SW8', category_name: '교통,수송 > 지하철', y: '35.1578', x: '129.0592', address_name: '부산 부산진구 부전동 573-1' },
    { place_name: '서면역 부산2호선', category_group_code: 'SW8', category_name: '교통,수송 > 지하철', y: '35.1575', x: '129.0599', address_name: '부산 부산진구 부전동 573-2' },
    { place_name: '서면행정복지센터', category_group_code: 'PO3', category_name: '공공,사회기관 > 행정기관', y: '35.83', x: '129.04', address_name: '경북 경주시 서면 아화리 1' }],
};
function mk(scope) {
  const kakao = { maps: { services: { Status: { OK: 'OK' }, Geocoder: function () { this.addressSearch = (t, cb) => { const d = DB[t] || []; cb(d, d.length ? 'OK' : 'ZERO'); }; } } } };
  const ps = { keywordSearch: (t, cb) => { const d = KW[t] || []; cb(d, d.length ? 'OK' : 'ZERO'); } };
  return load(['AREA_TAIL', 'AREA_CAT', 'SPOKEN', 'spokenOf', 'AREA_FILL', 'cleanArea', 'AREA_FIX', 'resolveArea', 'fin0', 'mergeSubDong', 'AREA_SCOPES', 'SCOPE_RE', 'areaScope', 'scopeName', 'distanceM', 'refLL'],
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
  assert.equal(show(await resolveArea('명동')), '밖 경남 창원시 진해구 명동 | 서울 중구 명동');   // 범위 밖에만 → 보여 주고 물음, 명동1가·2가는 하나로
  assert.equal(show(await resolveArea('제주')), '하나 제주특별자치도');                  // 시·도만 말하면 도 전체
  assert.equal(show(await resolveArea('신평역')), '하나 신평역 · 부산 사하구');           // 역 이름
});

test('행정 동네가 아닌 부산 서면은 서면역으로 (비슷한 글자 면 이름은 버림)', async () => {
  const { resolveArea } = mk('부산');
  assert.equal(show(await resolveArea('서면')), '하나 서면역 · 부산 부산진구');
  assert.equal(show(await resolveArea('부산 서면')), '하나 서면역 · 부산 부산진구');
  const all = await mk('all').resolveArea('서면');
  assert.ok(all.multi && all.list[0].label === '서면역 · 부산 부산진구', show(all));
  assert.ok(!show(all).includes('금강송면') && !show(all).includes('연서면'), show(all));
  assert.equal(all.list.length, 4, show(all));   // 서면역(부산) + 경주·남해·순천 서면
});

test('숫자만 다른 동(남포동1가·3가·6가, 하단1동·2동)은 한 동네', async () => {
  const { resolveArea } = mk('부산');
  const r = await resolveArea('남포동');
  assert.equal(show(r), '하나 부산 중구 남포동');
  assert.ok(Math.abs(r.area.lat - 35.098) < 0.002);   // 가운데는 평균
  assert.equal(show(await resolveArea('하단')), '하나 부산 사하구 하단동');
});

test('지역 + 종류말은 별점 검색으로 보낼 말', () => {
  const { KIND_TAIL } = load(['KIND_TAIL']);
  for (const t of ['서면 커피', '부산 서면 커피', '하단 돼지국밥 맛집', '해운대 횟집', '연지동 국밥집']) assert.ok(KIND_TAIL.test(t), t);
  for (const t of ['서면커피', '정짓간 신평본점', '연지2차청구아파트', '커피']) assert.ok(!KIND_TAIL.test(t), t);
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
