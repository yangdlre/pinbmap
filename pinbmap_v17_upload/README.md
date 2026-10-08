# pinbmap

good food, good coffee.

- `index.html` : 앱 본체 (카카오 지도)
- `netlify/functions/kplace.mjs` : 평점·리뷰·블로그 수·유가·충전기 상태를 가져오는 작은 서버 함수 (Netlify에서만 동작)
- `netlify.toml` : Netlify 설정 (빌드 없음, 함수 폴더 지정)

GitHub Pages에서는 함수가 돌지 않아 거리 기준으로만 동작합니다.
