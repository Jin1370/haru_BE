// 기존 profile_photos.converted_url 일회 백필: 다운로드 → JPEG q75 재인코딩 → 같은
// path 로 upsert. URL 불변이라 DB/FE 무변경 (클라이언트 HTTP 캐시는 1시간 뒤 ETag
// 재검증으로 자연 교체). 신규 사진은 services/photoConversion.ts 가 업로드 시 처리.
//
// Fly 머신 안에서 실행 (prod service_role 이 로컬에 없음):
//   fly ssh console -a haru-be -C "node -e \"$(cat scripts/recompress-profile-photos.cjs)\""
// 또는 로컬 .env(dev) 대상: node scripts/recompress-profile-photos.cjs
// 멱등: 이미 200KB 미만이면 skip.
const Jimp = require('jimp');
const QUALITY = 75;
const SKIP_BELOW = 200 * 1024;
const u = process.env.SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: k, Authorization: `Bearer ${k}` };

(async () => {
  const rows = await (await fetch(
    `${u}/rest/v1/profile_photos?select=id,converted_url&status=eq.ready&converted_url=not.is.null&limit=10000`,
    { headers: h },
  )).json();
  let done = 0, skipped = 0, failed = 0, before = 0, after = 0;
  for (const r of rows) {
    try {
      const path = decodeURIComponent(r.converted_url.split('/object/public/photos/')[1]);
      const res = await fetch(r.converted_url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const src = Buffer.from(await res.arrayBuffer());
      if (src.length < SKIP_BELOW) { skipped++; continue; }
      const out = await (await Jimp.read(src)).quality(QUALITY).getBufferAsync(Jimp.MIME_JPEG);
      const up = await fetch(`${u}/storage/v1/object/photos/${path}`, {
        method: 'POST', body: out,
        headers: { ...h, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
      });
      if (!up.ok) throw new Error(`upload ${up.status} ${await up.text()}`);
      before += src.length; after += out.length; done++;
    } catch (e) {
      failed++; console.error('[fail]', r.id, e.message);
    }
  }
  console.log(`R: done=${done} skipped=${skipped} failed=${failed} ${(before/1048576).toFixed(1)}MB -> ${(after/1048576).toFixed(1)}MB`);
})();
