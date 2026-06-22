import { supabase } from '../config/supabase';

export async function uploadFile(
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, body, { contentType, upsert: true });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

export async function deleteFile(bucket: string, path: string): Promise<void> {
  const { error } = await supabase.storage.from(bucket).remove([path]);

  if (error) {
    throw new Error(`Storage delete failed: ${error.message}`);
  }
}

export function extractPath(bucket: string, publicUrl: string): string {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) {
    throw new Error('Invalid storage URL');
  }
  return decodeURIComponent(publicUrl.slice(idx + marker.length));
}

// LAUNCH_CHECKLIST #3 — 클론 보이스 버킷(voice-intro-audio)을 private 로 돌린 뒤,
// 무인증 영구 다운로드(딥페이크 학습용 수집) 표면을 없애기 위한 on-read 서명 URL.
//
// DB(voice_intro_audio_urls JSONB)에는 여전히 public 형식 URL 이 "경로 운반체"로
// 저장돼 있다(데이터 마이그레이션 회피). 읽기 시점에 그 저장값에서 경로를 추출해
// 짧은 TTL 서명 URL 을 새로 발급한다. 버킷이 private 이라 저장된 public URL 자체는
// 더 이상 동작하지 않으므로, 클라이언트가 영구 URL 을 손에 쥐는 경로가 사라진다.
//
// 1시간 TTL: 디스커버 카드 프리페치 → 스와이프 청취까지의 브라우징 세션을 넉넉히
// 커버하면서도, URL 이 유출돼도 1시간 뒤 만료된다. 보이스 인트로는 본래 시청자에게
// 들려주는 표면이라 per-listen 비밀이 아니다 — 막으려는 건 영구 URL 의 익명 대량 수집.
export const SIGNED_URL_DEFAULT_TTL = 60 * 60;

export async function createSignedUrlFromStored(
  bucket: string,
  storedUrl: string | null | undefined,
  expiresIn: number = SIGNED_URL_DEFAULT_TTL,
): Promise<string | null> {
  if (!storedUrl) return null;
  let path: string;
  try {
    // 저장값이 이미 서명 URL(쿼리 포함)일 가능성까지 방어해 path 부분만 추출.
    path = extractPath(bucket, storedUrl.split('?')[0]);
  } catch {
    return null;
  }
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error || !data) {
    console.error(`[Signed URL failed] bucket=${bucket} path=${path}`, error?.message);
    return null;
  }
  return data.signedUrl;
}

// 슬롯 JSONB(예: voice_intro_audio_urls 의 {ko,ja,en}) 전체를 서명 URL 로 변환.
// 본인 프로필 조회(GET /me)처럼 단일 슬롯이 아니라 여러 슬롯을 한 번에 노출하는
// 경로용. 각 슬롯은 독립적으로 서명되며 실패/빈 값은 null 로 떨어진다.
export async function createSignedSlotUrls(
  bucket: string,
  storedSlots: Record<string, string | null | undefined> | null | undefined,
  expiresIn: number = SIGNED_URL_DEFAULT_TTL,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (!storedSlots) return out;
  await Promise.all(
    Object.entries(storedSlots).map(async ([lang, url]) => {
      out[lang] = await createSignedUrlFromStored(bucket, url, expiresIn);
    }),
  );
  return out;
}
