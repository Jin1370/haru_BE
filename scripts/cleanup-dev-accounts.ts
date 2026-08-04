// 시드 계정 일괄 삭제.
//
// 식별 기준: auth.users.user_metadata.is_dev_seed === true
// (auth.users.raw_user_meta_data JSONB 안의 'is_dev_seed' 키. 마커가 단일 진실원)
//
// 사용:
//   npx tsx scripts/cleanup-dev-accounts.ts
//   npx tsx scripts/cleanup-dev-accounts.ts --dry-run   # 미리보기만
//
// 주의:
//   SQL 로 수동 마크(is_dev_seed=true)한 계정도 동일 기준에 걸려 삭제됨.
//   보존하려면 cleanup 전에 그 계정의 is_dev_seed 마커를 지우세요.
//
// 삭제 순서:
//   1) Storage 정리 (voice-messages 는 CASCADE 로 경로를 잃기 전에 먼저)
//   2) ElevenLabs 보이스 클론 (mig 049 트리거가 미정리 계정의 삭제를 거부)
//   3) auth.users 삭제 → profiles/swipes/matches/messages/blocks/reports/user_preferences
//      는 ON DELETE CASCADE 로 자동 정리.

import 'dotenv/config';
import { supabase } from '../src/config/supabase';
import { purgeUserFolders, purgeUserVoiceMessages } from '../src/services/storage';
import { purgeVoiceClone } from './purge-voice-clone';

const DRY_RUN = process.argv.includes('--dry-run');

async function cleanupStorageFor(userId: string): Promise<void> {
  if (DRY_RUN) {
    console.log('  [dry] storage 정리 스킵');
    return;
  }
  // voice-messages 는 계정 삭제 전에 — CASCADE 후엔 경로를 잃는다.
  console.log(`  voice-messages: ${await purgeUserVoiceMessages(userId)} files removed`);
  console.log(`  photos + voice-intro-audio: ${await purgeUserFolders(userId)} files removed`);
}

async function listDevSeedUserIds(): Promise<{ id: string; email: string | null }[]> {
  const out: { id: string; email: string | null }[] = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`listUsers 실패: ${error.message}`);
    }
    for (const user of data.users) {
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      if (meta.is_dev_seed === true) {
        out.push({ id: user.id, email: user.email ?? null });
      }
    }
    if (data.users.length < perPage) break;
    page++;
  }
  return out;
}

async function main() {
  console.log('=== haru dev account cleanup ===');
  if (DRY_RUN) console.log('** DRY RUN — 아무것도 삭제하지 않습니다 **');
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ?? '(unset)'}`);

  const targets = await listDevSeedUserIds();
  console.log(`\n식별된 dev 계정: ${targets.length}`);
  if (targets.length === 0) {
    console.log('삭제할 계정이 없습니다.');
    return;
  }
  for (const t of targets) {
    console.log(`  - ${t.id} (${t.email ?? 'no email'})`);
  }

  if (!DRY_RUN) {
    console.log('\n5초 후 삭제 시작합니다. 취소하려면 Ctrl+C.');
    await new Promise((r) => setTimeout(r, 5000));
  }

  let okCount = 0;
  let failCount = 0;
  for (const t of targets) {
    console.log(`\nDeleting ${t.id} (${t.email})`);
    try {
      await cleanupStorageFor(t.id);
      if (DRY_RUN) {
        console.log('  [dry] voice clone / auth.users 삭제 스킵');
        okCount++;
        continue;
      }
      // mig 049 트리거가 voice_id 가 남은 계정의 삭제를 거부한다. 실패 시 throw
      // → 이 계정만 실패 처리하고 다음으로 넘어간다.
      await purgeVoiceClone(t.id);
      const { error } = await supabase.auth.admin.deleteUser(t.id);
      if (error) {
        console.error(`  ✗ deleteUser 실패: ${error.message}`);
        failCount++;
      } else {
        console.log('  ✓ deleted (CASCADE → profiles/swipes/matches/messages/...)');
        okCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ 예외: ${msg}`);
      failCount++;
    }
  }

  console.log('\n=== Cleanup complete ===');
  console.log(`성공: ${okCount} / 실패: ${failCount}`);
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Cleanup aborted:', err);
  process.exit(1);
});
