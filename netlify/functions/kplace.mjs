// 핀볼 맛집 검색 — 카카오 장소 상세(평점·리뷰·블로그·방문자·유가·충전기) 요약 프록시
// 호출: /.netlify/functions/kplace?ids=123,456,...   (최대 20개)
// 카카오맵 웹이 쓰는 공개 패널 데이터를 요약만 돌려줍니다. 카카오가 형식을 바꾸면 빈 값이 올 수 있고,
// 그 경우 앱은 거리 기준으로 자동 전환됩니다.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'pf': 'web',
  'Referer': 'https://place.map.kakao.com/',
  'Accept': 'application/json'
};
const TTL = 30 * 60 * 1000;            // 평점·가격
const TTL_EV = 90 * 1000;               // 충전기 빈자리는 금방 바뀌므로 1분 30초
const cache = globalThis.__pinbCache || (globalThis.__pinbCache = new Map());

function pick(d) {
  const o = {};
  const ss = d.kakaomap_review && d.kakaomap_review.score_set;
  if (ss) { o.r = ss.average_score; o.n = ss.review_count; }
  if (d.blog_review) o.b = d.blog_review.review_count;
  const tr = d.trend_rank;
  if (tr && tr.display_text) o.badge = tr.display_text;
  if (tr && tr.menu_rank && tr.menu_rank.rank) o.rank = tr.menu_rank.rank;
  if (!o.badge && Array.isArray(d.place_badge) && d.place_badge[0] && d.place_badge[0].text) o.badge = d.place_badge[0].text;
  if (Array.isArray(d.award_trend_rank) && d.award_trend_rank.length) o.award = d.award_trend_rank.map(a => a.title).filter(Boolean).slice(0, 3);
  const uv = d.visitor && d.visitor.weekly_uv_average;
  if (Array.isArray(uv)) o.uv = uv;
  const h = d.open_hours && d.open_hours.headline;
  if (h) o.open = { c: h.code || '', t: h.display_text || '', i: h.display_text_info || '' };
  // 주차장·입구 좌표 (오름·해변은 대표 위치와 차 댈 곳이 다른 경우가 많음)
  if (Array.isArray(d.navi_guides) && d.navi_guides.length) o.navi = d.navi_guides.slice(0, 4)
    .filter(g => g && g.point && Number.isFinite(+g.point.lat) && Number.isFinite(+g.point.lon))
    .map(g => ({ n: String(g.name || '').slice(0, 20), t: g.type || '', y: +g.point.lat, x: +g.point.lon }));
  const g = d.gas_station;
  if (g) o.gas = { g: g.price_gas, p: g.price_premium_gas, d: g.price_diesel, l: g.price_lpg,
    ag: g.avg_price_gas, ad: g.avg_price_diesel, al: g.avg_price_lpg, t: g.time_gas || g.time_diesel || '' };
  const ev = d.ev_kakao;
  if (ev) {
    const bi = ev.base_info || {};
    const groups = (ev.charger_renewal_info && ev.charger_renewal_info.charger_groups) || [];
    let kw = 0, fast = 0, fastAv = 0, slow = 0, slowAv = 0;
    groups.forEach(gr => {
      (gr.chargers || []).forEach(c => {
        const p = +(c.power || gr.power || 0);
        kw = Math.max(kw, p);
        const isFast = (c.filters || []).includes('FAST') || gr.speed === 'FAST' || p >= 50;
        const av = (c.filters || []).includes('AVAILABLE') || c.main_phrase_type === 'AVAILABLE';
        if (isFast) { fast++; if (av) fastAv++; } else { slow++; if (av) slowAv++; }
      });
    });
    o.ev = { tot: bi.charger_total_cnt ?? (fast + slow), av: bi.charger_avail_cnt ?? (fastAv + slowAv),
      kw, fast, fastAv, slow, slowAv, op: bi.op_name || '', pub: bi.open_place_label || '', kind: bi.s_code_name || '',
      hours: bi.business_hours || '', park: bi.free_parking_yn || '' };
  }
  return o;
}

async function one(id) {
  const c = cache.get(id);
  if (c && Date.now() - c.t < (c.v && c.v.ev ? TTL_EV : TTL)) return c.v;
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(`https://place-api.map.kakao.com/places/panel3/${id}`, { headers: HEADERS, signal: ctl.signal });
    if (!r.ok) return { err: r.status };
    const v = pick(await r.json());
    cache.set(id, { t: Date.now(), v });
    return v;
  } catch (e) {
    return { err: 'fetch' };
  } finally {
    clearTimeout(tm);
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const ids = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(s => /^\d{1,12}$/.test(s));
  const uniq = [...new Set(ids)].slice(0, 20);
  const out = {};
  // 동시에 10개씩 (Netlify 함수 제한시간 10초 안에 끝나도록)
  for (let i = 0; i < uniq.length; i += 10) {
    const part = uniq.slice(i, i + 10);
    const res = await Promise.all(part.map(one));
    part.forEach((id, k) => { out[id] = res[k]; });
  }
  const hasEv = Object.values(out).some(v => v && v.ev);
  const hasErr = Object.values(out).some(v => !v || v.err);   // 실패가 섞인 응답은 캐시하지 않음 (다시 검색하면 새로 시도)
  return new Response(JSON.stringify(out), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': hasErr ? 'no-store' : hasEv ? 'public, max-age=60' : 'public, max-age=600',
      'access-control-allow-origin': '*'
    }
  });
};
