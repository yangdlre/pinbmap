# pinbmap

good food, good coffee.

- `index.html` : 앱 본체 (카카오 지도)
- `netlify/functions/kplace.mjs` : 평점·리뷰·블로그 수·유가·충전기 상태를 가져오는 작은 서버 함수 (Netlify에서만 동작)
- `netlify/functions/sync.mjs` : 여행방(일정표·할일·경비)과 내 설정 코드(기기끼리 설정)를 맞추는 저장 함수 (Netlify Blobs 사용)
- `package.json` : 위 저장 함수가 쓰는 라이브러리 목록 (Netlify가 배포할 때 자동 설치)
- `netlify.toml` : Netlify 설정 (빌드 없음, 함수 폴더 지정)

GitHub Pages에서는 함수가 돌지 않아 거리 기준으로만 동작합니다.
