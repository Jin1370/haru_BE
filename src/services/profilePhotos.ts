import { supabase } from '../config/supabase';

// mig 034: profiles.photos 컬럼 폐지 후 ready 사진 일괄 조회의 단일 경로
// (디스커버 / 받은좋아요 / 매치 목록 공용 — 종전 3곳의 byte-identical 인라인 블록 통합).
// status='ready' 변환본을 position ASC 로 모아 user 별 배열로 반환. [0] = main(position=0).
// 조회 실패는 로그만 남기고 빈 Map 반환 — 호출처가 "사진 0장" 으로 graceful-degrade
// 처리하는 기존 동작 유지. logTag 는 종전 인라인 블록의 로그 프리픽스 보존용.
export async function fetchReadyPhotosByUser(
  userIds: string[],
  logTag: string,
): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  if (userIds.length === 0) return byUser;

  const { data, error } = await supabase
    .from('profile_photos')
    .select('user_id, position, converted_url, status')
    .in('user_id', userIds)
    .eq('status', 'ready')
    .order('position', { ascending: true });

  if (error) {
    console.error(`[${logTag}.profile_photos_select_failed]`, error.message);
    return byUser;
  }

  ((data ?? []) as Array<{ user_id: string; converted_url: string | null }>).forEach((r) => {
    if (!r.converted_url) return;
    const list = byUser.get(r.user_id) ?? [];
    list.push(r.converted_url);
    byUser.set(r.user_id, list);
  });
  return byUser;
}
