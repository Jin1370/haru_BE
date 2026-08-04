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

// ── 사용자 자산 정리 ────────────────────────────────────────────────
// 탈퇴(anonymize) 와 계정 하드 삭제가 공유. 이전엔 auth.ts / delete-user.ts /
// cleanup-dev-accounts.ts 가 각자 구현해 서로 어긋나 있었다 (스크립트 쪽은
// photos 하위 폴더를 안 훑어 사진 본체가 잔존).

// Storage list 는 재귀적이지 않아 하위 폴더를 안 훑는다 — 폴더별 호출 필요.
const USER_FOLDERS: Array<[bucket: string, folder: (u: string) => string]> = [
  ['photos', (u) => u], // 옛 평면 구조 (mig 028 이전) + dev 시드
  ['photos', (u) => `${u}/originals`], // 변환 전 원본 (실패/대기분 잔존 가능)
  ['photos', (u) => `${u}/converted`], // 워터컬러 변환본
  ['voice-intro-audio', (u) => u],
];

async function removeFolder(bucket: string, folder: string): Promise<number> {
  const { data: files, error: listErr } = await supabase.storage.from(bucket).list(folder);
  if (listErr) throw new Error(`list ${bucket}/${folder}: ${listErr.message}`);
  // 하위 폴더 엔트리(id === null)는 remove 대상이 아니다 — 위 목록이 직접 훑는다.
  const paths = (files ?? []).filter((f) => f.id !== null).map((f) => `${folder}/${f.name}`);
  if (paths.length === 0) return 0;
  const { error: rmErr } = await supabase.storage.from(bucket).remove(paths);
  if (rmErr) throw new Error(`remove ${bucket}/${folder}: ${rmErr.message}`);
  return paths.length;
}

// 사진 + 보이스 한마디. userId 로 경로가 결정되므로 계정 삭제 전후 아무 때나 호출 가능.
export async function purgeUserFolders(userId: string): Promise<number> {
  const counts = await Promise.all(USER_FOLDERS.map(([b, f]) => removeFolder(b, f(userId))));
  return counts.reduce((a, b) => a + b, 0);
}

// 음성 메시지. voice-messages 버킷은 `{messageId}.mp3` 평면 구조라 userId 폴더가
// 없다 — messages.audio_url 로만 소유자를 알 수 있고, 계정을 하드 삭제하면 매치
// CASCADE 로 그 행들이 사라져 영구 고아가 된다. **반드시 삭제 전** 에 호출할 것.
//
// 상대가 보낸 메시지도 포함한다: 매치가 CASCADE 로 지워지면 양쪽 메시지 행이 모두
// 사라지므로 상대의 음성 파일도 같이 고아가 된다.
//
// 탈퇴(anonymize) 경로에서는 호출하지 않는다 — 매치·메시지가 살아있어 상대방
// 채팅방에서 계속 재생돼야 하고, 30일 TTL sweep 이 나중에 회수한다.
export async function purgeUserVoiceMessages(userId: string): Promise<number> {
  const { data: matches, error: matchErr } = await supabase
    .from('matches')
    .select('id')
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);
  if (matchErr) throw new Error(`matches 조회 실패: ${matchErr.message}`);
  const matchIds = (matches ?? []).map((m) => m.id as string);
  if (matchIds.length === 0) return 0;

  const { data: msgs, error: msgErr } = await supabase
    .from('messages')
    .select('audio_url')
    .in('match_id', matchIds)
    .not('audio_url', 'is', null);
  if (msgErr) throw new Error(`messages 조회 실패: ${msgErr.message}`);

  const paths: string[] = [];
  for (const m of msgs ?? []) {
    try {
      paths.push(extractPath('voice-messages', (m.audio_url as string).split('?')[0]));
    } catch {
      // legacy/corrupted URL — 경로를 못 만들면 스킵 (지울 대상을 특정 못 함).
    }
  }
  if (paths.length === 0) return 0;

  const { error: rmErr } = await supabase.storage.from('voice-messages').remove(paths);
  if (rmErr) throw new Error(`remove voice-messages: ${rmErr.message}`);
  return paths.length;
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
