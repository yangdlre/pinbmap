// 📋 카드 문자 읽기 (가계부) — parseSms · guessCat
// 표본은 모두 지어낸 가짜 문자 (실제 카드번호·이름·전화번호 넣지 말 것 — 저장소와 사이트가 공개라서)
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fixedNow, lsDefault, plain } from './harness.mjs';

const { parseSms, guessCat } = load(
  ['parseSms', 'guessCat', 'bookCats', 'BOOK_CATS', 'CARD_RE', 'CAT_KW'],
  { nowKST: fixedNow('2026-10-16'), lsGet: lsDefault },
);
// 비교할 칸만 (raw·ok는 뺌)
const pick = rows => plain(rows).map(({ amt, d, tm, title, pay, cat, cancel }) => ({ amt, d, tm, title, pay, cat, cancel }));
const hm = (h, m) => h * 60 + m;

test('KB국민 기본 승인 문자: 금액·날짜·시각·가게·카드·분류', () => {
  const r = pick(parseSms(`[Web발신]
KB국민카드1234승인
홍*동님
12,000원 일시불
10/13 18:23
스타벅스제주점
누적1,234,560원`));
  assert.deepEqual(r, [{ amt: 12000, d: '2026-10-13', tm: hm(18, 23), title: '스타벅스제주점', pay: 'KB국민카드', cat: 'cafe', cancel: false }]);
});

test('한 줄짜리 승인 문자 (신한): 누적 금액을 금액으로 읽지 않음', () => {
  const r = pick(parseSms('[Web발신]\n신한카드(1234)승인 홍*동 45,000원(일시불)10/14 12:05 흑돼지명가 누적1,500,000원'));
  assert.deepEqual(r, [{ amt: 45000, d: '2026-10-14', tm: hm(12, 5), title: '흑돼지명가', pay: '신한카드', cat: 'food', cancel: false }]);
});

test('알림톡 항목형 (하나): 가맹점명·거래시간 칸으로 읽음 (v0.43)', () => {
  const r = pick(parseSms(`[하나카드] 승인 안내
홍*동님
하나카드(1234) 승인
승인금액 : 8,500원
가맹점명 : 제주감귤농장
거래시간 : 10/15 14:30`));
  assert.deepEqual(r, [{ amt: 8500, d: '2026-10-15', tm: hm(14, 30), title: '제주감귤농장', pay: '하나카드', cat: 'souv', cancel: false }]);
});

test('승인취소는 마이너스(환불)', () => {
  const r = pick(parseSms(`[Web발신]
KB국민카드1234승인취소
홍*동님
12,000원
10/13 19:02
스타벅스제주점`));
  assert.equal(r.length, 1);
  assert.equal(r[0].amt, -12000);
  assert.equal(r[0].cancel, true);
  assert.equal(r[0].title, '스타벅스제주점');
});

test("'취소할 수 없습니다' 안내 문구는 환불이 아님 (v0.44)", () => {
  const r = pick(parseSms(`[Web발신]
[현대카드] 승인
홍*동님 33,000원 일시불
10/12 20:10 제주렌터카
※ 렌터카 예약은 현장에서 취소할 수 없습니다`));
  assert.equal(r.length, 1);
  assert.equal(r[0].amt, 33000);
  assert.equal(r[0].cancel, false);
  assert.equal(r[0].title, '제주렌터카');
  assert.equal(r[0].cat, 'move');
});

test('빈 줄로 나뉜 여러 통을 건마다 나눔', () => {
  const r = pick(parseSms(`삼성카드 승인 홍*동 5,500원 일시불 10/16 08:10 메가커피 제주점

현대카드 승인 홍*동 2,000원 일시불 10/16 08:40 GS25 제주점`));
  assert.deepEqual(r.map(x => [x.amt, x.title, x.pay, x.cat]), [
    [5500, '메가커피 제주점', '삼성카드', 'cafe'],
    [2000, 'GS25 제주점', '현대카드', 'life'],
  ]);
});

test('연도 없는 문자: 오늘보다 두 달 넘게 뒤의 달이면 작년으로', () => {
  // 오늘 2026-10-16 기준, 12/28 문자는 2025년 것
  const r = pick(parseSms('[Web발신]\n신한카드(1234)승인 홍*동 9,000원(일시불)12/28 13:00 제주국수 누적9,000원'));
  assert.equal(r[0].d, '2025-12-28');
});

const KT_EXPORT = `KB국민카드 님과 카카오톡 대화
저장한 날짜 : 2026-10-16 21:00:00

2026년 10월 13일 오후 6:23, KB국민카드 : [Web발신]
KB국민카드1234승인
홍*동님
12,000원 일시불
10/13 18:23
스타벅스제주점
누적1,234,560원
2026년 10월 14일 오전 9:01, KB국민카드 : [KB국민카드] 소비쿠폰 안내
최대 10,000원 쿠폰을 드려요. [Web발신] 표시가 있어도 문자 속 링크는 누르지 마세요.
2026년 10월 14일 오후 12:05, KB국민카드 : [Web발신]
KB국민카드1234승인
홍*동님
45,000원 일시불
10/14 12:05
흑돼지명가
누적1,279,560원
2026년 10월 14일 오후 12:05, KB국민카드 : [Web발신]
KB국민카드1234승인
홍*동님
45,000원 일시불
10/14 12:05
흑돼지명가
누적1,279,560원`;

test('카톡 대화 내보내기: 날짜 머리 줄마다 한 건, 안내문은 빼고, 끝에 붙은 중복은 한 번만 (v0.44)', () => {
  const r = pick(parseSms(KT_EXPORT));
  assert.deepEqual(r.map(x => [x.d, x.tm, x.amt, x.title]), [
    ['2026-10-13', hm(18, 23), 12000, '스타벅스제주점'],
    ['2026-10-14', hm(12, 5), 45000, '흑돼지명가'],
  ]);
});

test('카톡 내보내기의 연도는 머리 줄에서 (해 넘김: 1월 머리 줄의 12/31 문자는 작년)', () => {
  const r = pick(parseSms(`2027년 1월 2일 오전 10:00, 신한카드 : [Web발신]
신한카드(1234)승인 홍*동 20,000원(일시불)12/31 23:10 제주포차 누적20,000원`));
  assert.equal(r.length, 1);
  assert.equal(r[0].d, '2026-12-31');
  assert.equal(r[0].cat, 'drink');
});

test('금액이 없는 글은 건으로 안 잡음', () => {
  assert.deepEqual(plain(parseSms('[Web발신]\n[KB국민카드] 문자명세서 신청 안내\n매월 명세서를 문자로 받아 보세요.')), []);
  assert.deepEqual(plain(parseSms('')), []);
});

test('분류 짐작: 배달앱은 식비, 쿠팡이츠는 식비 / 쿠팡은 쇼핑 (v0.44)', () => {
  assert.equal(guessCat('우아한형제들'), 'food');
  assert.equal(guessCat('배달의민족'), 'food');
  assert.equal(guessCat('쿠팡이츠'), 'food');
  assert.equal(guessCat('쿠팡'), 'shop');
  assert.equal(guessCat('카카오T 택시'), 'move');
  assert.equal(guessCat('알 수 없는 가게'), 'etc');
});

test("'제주점'(지점 이름)을 술집의 '주점'으로 읽지 않음", () => {
  // 고치기 전: GS25 제주점·이마트 제주점·흑돼지명가 제주점이 모두 '술'로 분류됐음
  assert.equal(guessCat('GS25 제주점'), 'life');
  assert.equal(guessCat('이마트 신제주점'), 'life');
  assert.equal(guessCat('흑돼지명가 제주점'), 'food');
  assert.equal(guessCat('제주주점'), 'drink');
  assert.equal(guessCat('동문 요리주점'), 'drink');
  assert.equal(guessCat('주점 하루'), 'drink');
});
