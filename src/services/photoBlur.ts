import Jimp from 'jimp';
import { supabase } from '../config/supabase';
import { uploadFile } from './storage';

// 잠긴 카드(받은 좋아요 미공개 / 탐색 한도 초과)에 원본 대신 내려주는 블러 사진.
// 화면에서만 블러를 씌우면 응답에 원본 URL 이 남아 결제 우회가 되므로 서버가
// 블러본을 만든다. 메인 사진 1장만, 처음 필요할 때 만들어 profile_photos.blurred_url
// 에 저장하고 재사용 (요청마다 만들면 Fly 메모리 부담 — 2026-07 OOM).
// 작게 줄여서 흐리면 원본 디테일이 구조적으로 남지 않고 용량도 수 KB.
const BLUR_WIDTH = 96;
const BLUR_RADIUS = 6;

async function makeBlurred(sourceUrl: string): Promise<Buffer> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const image = await Jimp.read(Buffer.from(await res.arrayBuffer()));
  return image
    .resize(BLUR_WIDTH, Jimp.AUTO)
    .blur(BLUR_RADIUS)
    .quality(60)
    .getBufferAsync(Jimp.MIME_JPEG);
}

// userId → 메인 사진 블러 URL. 실패한 사용자는 맵에서 빠진다 (호출처가 사진 없는
// 잠긴 카드로 처리).
export async function getBlurredMainPhotos(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;

  const { data, error } = await supabase
    .from('profile_photos')
    .select('id, user_id, converted_url, blurred_url')
    .in('user_id', userIds)
    .eq('status', 'ready')
    .eq('position', 0);
  if (error) {
    console.error('[photoBlur.select_failed]', error.message);
    return out;
  }

  await Promise.all(
    (data ?? []).map(async (row: any) => {
      if (row.blurred_url) {
        out.set(row.user_id, row.blurred_url);
        return;
      }
      if (!row.converted_url) return;
      try {
        const buffer = await makeBlurred(row.converted_url);
        const url = await uploadFile('photos', `${row.user_id}/blurred/${row.id}.jpg`, buffer, 'image/jpeg');
        const { error: updErr } = await supabase
          .from('profile_photos')
          .update({ blurred_url: url })
          .eq('id', row.id);
        if (updErr) console.error('[photoBlur.save_failed]', updErr.message);
        out.set(row.user_id, url);
      } catch (e) {
        console.error('[photoBlur.generate_failed]', row.id, (e as Error).message);
      }
    }),
  );
  return out;
}
