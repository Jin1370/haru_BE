// 런칭 쿠폰: 초기 유저에게 무료 프리미엄(premium_until) 부여.
//
// 프리미엄 = 음성 30통/일 · 받은좋아요 무제한 · 광고 없음 (mig 033).
// premium_until 을 보조금 기간 이하 시각으로 set → 그 시각에 자동 무료 복귀
// (별도 해제 불필요, 빼앗기 아님). 결제 연동 없이 계정 플래그만으로 동작.
//
// 사용:
//   단일 유저  : npx tsx scripts/grant-premium.ts <email | user_id> [days=28]
//   전체 기존  : npx tsx scripts/grant-premium.ts --all [days=28]
//   해제       : npx tsx scripts/grant-premium.ts --revoke <email | user_id>
//
// ⚠️ days 는 ElevenLabs 보조금 잔여 기간 이하로 — 보조금 종료 후까지 가면 실비용 발생.

import 'dotenv/config';
import { supabase } from '../src/config/supabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_DAYS = 28;

async function resolveUserId(arg: string): Promise<string | null> {
  if (UUID_RE.test(arg)) {
    const { data, error } = await supabase.auth.admin.getUserById(arg);
    if (error || !data?.user) return null;
    return data.user.id;
  }
  const target = arg.trim().toLowerCase();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers 실패: ${error.message}`);
    const found = data.users.find((u) => (u.email ?? '').toLowerCase() === target);
    if (found) return found.id;
    if (data.users.length < perPage) break;
    page++;
  }
  return null;
}

function untilIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const revoke = args.includes('--revoke');
  const positionals = args.filter((a) => !a.startsWith('--'));
  const daysArg = positionals.find((a) => /^\d+$/.test(a));
  const days = daysArg ? parseInt(daysArg, 10) : DEFAULT_DAYS;
  const target = positionals.find((a) => !/^\d+$/.test(a));

  if (all) {
    const until = untilIso(days);
    const { data, error } = await supabase
      .from('profiles')
      .update({ premium_until: until })
      .not('id', 'is', null)
      .select('id');
    if (error) {
      console.error('[grant-premium] --all 실패:', error.message);
      process.exit(1);
    }
    console.log(`✅ 기존 유저 ${data?.length ?? 0}명에게 프리미엄 부여 (만료: ${until})`);
    return;
  }

  if (!target) {
    console.error('Usage: npx tsx scripts/grant-premium.ts <email|user_id> [days] | --all [days] | --revoke <email|user_id>');
    process.exit(1);
  }

  const userId = await resolveUserId(target);
  if (!userId) {
    console.error(`[grant-premium] 유저 못 찾음: ${target}`);
    process.exit(1);
  }

  const premiumUntil = revoke ? null : untilIso(days);
  const { error } = await supabase
    .from('profiles')
    .update({ premium_until: premiumUntil })
    .eq('id', userId);
  if (error) {
    console.error('[grant-premium] 업데이트 실패:', error.message);
    process.exit(1);
  }
  console.log(
    revoke
      ? `✅ 프리미엄 해제: ${target}`
      : `✅ 프리미엄 부여: ${target} (만료: ${premiumUntil})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
