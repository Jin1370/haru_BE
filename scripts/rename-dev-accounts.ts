// is_dev_seed=true 계정을 Test1/Test2/... 일관 명명으로 일괄 변경.
//
// 변경 내용 (인덱스 N = 1, 2, ...):
//   * profiles.display_name = `Test{N}`
//   * auth.users.email      = `test{N}@estsoft.com`  (email_confirm=true 로 confirmation 스킵)
//   * auth.users.password   = `aaaa1111`
//
// 정렬 기준: user_metadata.persona_index ASC (seed 스크립트가 부여한 순서, null 은 뒤로) →
//            created_at ASC. 대시보드 사이드바 순서와 일치.
//
// 사용:
//   npx tsx scripts/rename-dev-accounts.ts            # 실제 변경
//   npx tsx scripts/rename-dev-accounts.ts --dry-run  # 미리보기만
//
// 충돌 처리:
//   대상 이메일이 다른 계정에서 이미 사용 중이면 Supabase 가 거부 → 해당 row 만 skip,
//   다음 row 계속. 충돌 회피하려면 사전에 unmark/cleanup 으로 충돌 계정 정리.
//
// 멱등성:
//   재실행해도 안전. 이미 같은 email/display_name 이면 그대로 update 가 통과 (Supabase
//   의 자기 자신 email 재할당은 허용).

import 'dotenv/config';
import { supabase } from '../src/config/supabase';

const DRY_RUN = process.argv.includes('--dry-run');
const NEW_PASSWORD = 'aaaa1111';
const EMAIL_DOMAIN = 'estsoft.com';

type Target = {
  id: string;
  current_email: string | null;
  persona_index: number | null;
  created_at: string;
};

async function listTargets(): Promise<Target[]> {
  const out: Target[] = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers 실패: ${error.message}`);
    for (const u of data.users) {
      const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
      if (meta.is_dev_seed !== true) continue;
      out.push({
        id: u.id,
        current_email: u.email ?? null,
        persona_index: typeof meta.persona_index === 'number' ? meta.persona_index : null,
        created_at: u.created_at ?? new Date().toISOString(),
      });
    }
    if (data.users.length < perPage) break;
    page++;
  }
  // persona_index ASC (null 뒤), 동률 시 created_at ASC
  out.sort((a, b) => {
    if (a.persona_index !== null && b.persona_index !== null) {
      return a.persona_index - b.persona_index;
    }
    if (a.persona_index !== null) return -1;
    if (b.persona_index !== null) return 1;
    return a.created_at.localeCompare(b.created_at);
  });
  return out;
}

async function main() {
  console.log('=== haru dev account rename ===');
  if (DRY_RUN) console.log('** DRY RUN — 아무것도 변경하지 않습니다 **');
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ?? '(unset)'}`);

  const targets = await listTargets();
  console.log(`\n대상 계정: ${targets.length}`);
  if (targets.length === 0) {
    console.log('변경할 계정이 없습니다.');
    return;
  }

  console.log('\n변경 예정:');
  for (let i = 0; i < targets.length; i++) {
    const n = i + 1;
    const t = targets[i];
    console.log(
      `  ${String(n).padStart(2)}. ${t.id}  ${t.current_email ?? '(no email)'}` +
        `  →  Test${n} / test${n}@${EMAIL_DOMAIN}`,
    );
  }

  if (!DRY_RUN) {
    console.log('\n5초 후 변경 시작합니다. 취소하려면 Ctrl+C.');
    await new Promise((r) => setTimeout(r, 5000));
  }

  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const n = i + 1;
    const t = targets[i];
    const displayName = `Test${n}`;
    const email = `test${n}@${EMAIL_DOMAIN}`;

    console.log(`\n[${n}/${targets.length}] ${t.id} → ${displayName} / ${email}`);

    if (DRY_RUN) {
      console.log('  [dry] skip');
      okCount++;
      continue;
    }

    // 1) auth.users: email + password 갱신. email_confirm=true 로 메일 확인 단계 우회.
    const { error: authErr } = await supabase.auth.admin.updateUserById(t.id, {
      email,
      password: NEW_PASSWORD,
      email_confirm: true,
    });
    if (authErr) {
      console.error(`  ✗ auth update 실패: ${authErr.message}`);
      failCount++;
      continue;
    }

    // 2) profiles.display_name 갱신
    const { error: profileErr } = await supabase
      .from('profiles')
      .update({
        display_name: displayName,
        updated_at: new Date().toISOString(),
      })
      .eq('id', t.id);
    if (profileErr) {
      console.error(`  ✗ profile update 실패: ${profileErr.message}`);
      // auth 는 이미 변경됐으나 profile 만 실패 — 다음 실행에서 재시도하면 동기화됨
      failCount++;
      continue;
    }

    console.log('  ✓ updated');
    okCount++;
  }

  console.log('\n=== Rename complete ===');
  console.log(`성공: ${okCount} / 실패: ${failCount}`);
  console.log(`\n로그인 정보: 비밀번호 ${NEW_PASSWORD} (전 계정 동일)`);
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Rename aborted:', err);
  process.exit(1);
});
