// 기존 계정을 어드민 대시보드에 노출시키기 위한 마커 추가.
//
// 안전 모델:
//   * 어드민 대시보드 + 임퍼소네이션 경로는 auth.users.user_metadata.is_dev_seed === true 만 허용.
//   * 본 스크립트는 그 마커를 기존 계정에 붙인다 (sub_metadata 보존).
//   * 출시 빌드에서는 ADMIN_DASHBOARD_ENABLED=false → 마커 있어도 의미 없음.
//
// 사용:
//   npx tsx scripts/mark-dev-account.ts <email | user_id>
//   npx tsx scripts/mark-dev-account.ts dev-test@example.com
//   npx tsx scripts/mark-dev-account.ts 12345678-...-...
//
// 해제:
//   npx tsx scripts/mark-dev-account.ts --unmark <email | user_id>
//
// cleanup 동작 관련:
//   기본 cleanup 은 seed 스크립트 이메일 패턴(dev-NN@haru.test)만 삭제. 본 스크립트로
//   마크한 계정은 cleanup 영향 없음. cleanup --all 플래그로만 포함됨.

import 'dotenv/config';
import { supabase } from '../src/config/supabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findUser(arg: string): Promise<{ id: string; email: string | null; metadata: Record<string, unknown> } | null> {
  // user_id (UUID) 직접 조회
  if (UUID_RE.test(arg)) {
    const { data, error } = await supabase.auth.admin.getUserById(arg);
    if (error || !data?.user) return null;
    return {
      id: data.user.id,
      email: data.user.email ?? null,
      metadata: (data.user.user_metadata ?? {}) as Record<string, unknown>,
    };
  }

  // email 로 스캔
  const target = arg.trim().toLowerCase();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`listUsers 실패: ${error.message}`);
    }
    const found = data.users.find((u) => (u.email ?? '').toLowerCase() === target);
    if (found) {
      return {
        id: found.id,
        email: found.email ?? null,
        metadata: (found.user_metadata ?? {}) as Record<string, unknown>,
      };
    }
    if (data.users.length < perPage) break;
    page++;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const unmark = args.includes('--unmark');
  const target = args.find((a) => !a.startsWith('--'));

  if (!target) {
    console.error('Usage: npx tsx scripts/mark-dev-account.ts [--unmark] <email | user_id>');
    process.exit(1);
  }

  const user = await findUser(target);
  if (!user) {
    console.error(`✗ 사용자를 찾을 수 없습니다: ${target}`);
    process.exit(1);
  }

  const currentMark = user.metadata.is_dev_seed === true;
  const label = user.email ?? user.id;

  if (unmark) {
    if (!currentMark) {
      console.log(`이미 unmark 상태: ${label}`);
      return;
    }
    const next = { ...user.metadata };
    delete next.is_dev_seed;
    delete next.marked_at;
    const { error } = await supabase.auth.admin.updateUserById(user.id, { user_metadata: next });
    if (error) {
      console.error(`✗ unmark 실패: ${error.message}`);
      process.exit(1);
    }
    console.log(`✓ Unmarked: ${label}`);
    return;
  }

  if (currentMark) {
    console.log(`이미 마크 상태: ${label}`);
    return;
  }

  const nextMetadata = {
    ...user.metadata,
    is_dev_seed: true,
    marked_at: new Date().toISOString(),
  };

  const { error } = await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: nextMetadata,
  });
  if (error) {
    console.error(`✗ mark 실패: ${error.message}`);
    process.exit(1);
  }

  console.log(`✓ Marked as dev_seed: ${label}`);
  console.log('  대시보드 새로고침하면 사이드바에 표시됩니다.');
}

main().catch((err) => {
  console.error('Aborted:', err);
  process.exit(1);
});
