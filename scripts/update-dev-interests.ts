// dev seed 계정 interests 를 canonical ID 로 일괄 교체.
//
// 배경:
//   초기 seed 가 localized 문자열 (카페투어, カフェ巡り 등) 을 직접 박아 넣어서
//   페르소나 언어별로 다른 표기가 그대로 노출됨. 정상 설계 (haru_FE/src/constants/interests.ts)
//   는 ID 만 저장하고 FE 가 i18n 으로 번역하는 구조 — 이 스크립트가 정합성 회복.
//
// 사용:
//   npx tsx scripts/update-dev-interests.ts
//   npx tsx scripts/update-dev-interests.ts --dry-run

import 'dotenv/config';
import { supabase } from '../src/config/supabase';

const DRY_RUN = process.argv.includes('--dry-run');

// persona_index → canonical interest IDs.
// 기존 일본어/한국어 라벨 매핑 그대로 의미 보존 (피아노·기타·바이크 등 ID 부재 항목은 가장 가까운 ID 로 치환).
const INTERESTS_BY_PERSONA_INDEX: Record<number, string[]> = {
  0: ['cafe', 'travel', 'photography'],     // 서연 ko F  (was 카페투어, 여행, 사진)
  1: ['reading', 'movies', 'yoga'],         // 하늘 ko F  (was 독서, 영화, 요가)
  2: ['gym', 'cooking', 'wine'],            // 지호 ko F  (was 운동, 쿠킹, 와인)
  3: ['gaming', 'driving', 'music'],        // 준영 ko M  (was 게임, 드라이브, 음악감상)
  4: ['gym', 'running', 'foodie'],          // 도현 ko M  (was 헬스, 러닝, 맛집)
  5: ['cafe', 'reading', 'travel'],         // さくら ja F (was カフェ巡り, 読書, 旅行)
  6: ['anime', 'music', 'jpop'],            // ゆい ja F   (was アニメ, 音楽, ピアノ — 피아노 ID 부재 → jpop)
  7: ['movies', 'gym', 'wine'],             // はるき ja M (was 映画, ジム, ワイン)
  8: ['soccer', 'music', 'foodie'],         // たくみ ja M (was サッカー, ギター, ラーメン — 기타 ID 부재 → music)
  9: ['hiking', 'photography', 'driving'],  // けんた ja M (was 登山, 写真, バイク — 바이크 ID 부재 → driving)
};

// 수동 마크 계정 (persona_index=null) 의 fallback.
// display_name 별 명시. 없으면 generic default 적용.
const INTERESTS_BY_DISPLAY_NAME: Record<string, string[]> = {
  Test1: ['cafe', 'fashion', 'travel'],
  Test2: ['gaming', 'anime', 'music'],
};

const DEFAULT_INTERESTS = ['cafe', 'travel', 'music'];

type Target = {
  user_id: string;
  display_name: string;
  persona_index: number | null;
  current_interests: string[];
  new_interests: string[];
};

async function listTargets(): Promise<Target[]> {
  // is_dev_seed=true 사용자 ID + persona_index 수집
  const seedUsers: { id: string; persona_index: number | null }[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers 실패: ${error.message}`);
    for (const u of data.users) {
      const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
      if (meta.is_dev_seed !== true) continue;
      seedUsers.push({
        id: u.id,
        persona_index: typeof meta.persona_index === 'number' ? meta.persona_index : null,
      });
    }
    if (data.users.length < 1000) break;
    page++;
  }
  if (seedUsers.length === 0) return [];

  const ids = seedUsers.map((u) => u.id);
  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, display_name, interests')
    .in('id', ids);
  if (error) throw new Error(`profiles fetch 실패: ${error.message}`);

  return (profiles ?? []).map((p) => {
    const su = seedUsers.find((s) => s.id === p.id)!;
    const newInterests =
      (su.persona_index !== null && INTERESTS_BY_PERSONA_INDEX[su.persona_index]) ||
      INTERESTS_BY_DISPLAY_NAME[p.display_name as string] ||
      DEFAULT_INTERESTS;
    return {
      user_id: p.id as string,
      display_name: p.display_name as string,
      persona_index: su.persona_index,
      current_interests: (p.interests as string[]) ?? [],
      new_interests: newInterests,
    };
  });
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function main() {
  console.log('=== dev interests → canonical IDs ===');
  if (DRY_RUN) console.log('** DRY RUN **');

  const targets = (await listTargets()).sort((a, b) => naturalSort(a.display_name, b.display_name));
  console.log(`\n대상 ${targets.length}명:\n`);
  for (const t of targets) {
    const before = t.current_interests.join(', ');
    const after = t.new_interests.join(', ');
    console.log(`  ${t.display_name.padEnd(8)} (persona_index=${t.persona_index ?? '(manual)'})`);
    console.log(`    이전: [${before}]`);
    console.log(`    이후: [${after}]`);
  }
  if (targets.length === 0) return;

  if (!DRY_RUN) {
    console.log('\n5초 후 시작합니다. 취소하려면 Ctrl+C.');
    await new Promise((r) => setTimeout(r, 5000));
  }

  let ok = 0;
  let fail = 0;
  for (const t of targets) {
    if (DRY_RUN) {
      console.log(`[dry] ${t.display_name} skip`);
      ok++;
      continue;
    }
    const { error } = await supabase
      .from('profiles')
      .update({ interests: t.new_interests, updated_at: new Date().toISOString() })
      .eq('id', t.user_id);
    if (error) {
      console.error(`✗ ${t.display_name}: ${error.message}`);
      fail++;
    } else {
      console.log(`✓ ${t.display_name}: [${t.new_interests.join(', ')}]`);
      ok++;
    }
  }
  console.log(`\n성공: ${ok} / 실패: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Aborted:', err);
  process.exit(1);
});
