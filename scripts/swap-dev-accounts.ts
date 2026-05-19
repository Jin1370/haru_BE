// 두 dev 계정의 display_name + email 을 스왑.
//
// 이메일이 unique constraint 가 있어 직접 교환 불가 → 중간 임시 이메일을 거쳐 3단계:
//   1) A 를 임시 이메일로 옮김
//   2) B 를 A 의 원래 이메일 + display_name 으로 갱신
//   3) A 를 B 의 원래 이메일 + display_name 으로 갱신
//
// persona_index 는 건드리지 않음 → rename:dev 재실행 시 원래대로 돌아감 (의도된 동작 X).
// 영구적 스왑이 필요하면 persona_index 도 같이 스왑해야 함 (별도 옵션).
//
// 사용:
//   npx tsx scripts/swap-dev-accounts.ts <userIdA> <userIdB>

import 'dotenv/config';
import { supabase } from '../src/config/supabase';

type Snapshot = {
  id: string;
  email: string;
  display_name: string;
};

async function snapshot(userId: string): Promise<Snapshot> {
  const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(userId);
  if (authErr || !authData?.user?.email) {
    throw new Error(`auth fetch 실패 (${userId}): ${authErr?.message ?? 'no email'}`);
  }
  const { data: profile, error: pErr } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', userId)
    .single();
  if (pErr || !profile) {
    throw new Error(`profile fetch 실패 (${userId}): ${pErr?.message ?? 'no profile'}`);
  }
  return {
    id: userId,
    email: authData.user.email,
    display_name: profile.display_name as string,
  };
}

async function setEmailAndName(userId: string, email: string, displayName: string) {
  const { error: authErr } = await supabase.auth.admin.updateUserById(userId, {
    email,
    email_confirm: true,
  });
  if (authErr) throw new Error(`auth update 실패 (${userId} → ${email}): ${authErr.message}`);
  const { error: pErr } = await supabase
    .from('profiles')
    .update({ display_name: displayName, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (pErr) throw new Error(`profile update 실패 (${userId}): ${pErr.message}`);
}

async function main() {
  const [aId, bId] = process.argv.slice(2);
  if (!aId || !bId) {
    console.error('Usage: npx tsx scripts/swap-dev-accounts.ts <userIdA> <userIdB>');
    process.exit(1);
  }

  const a = await snapshot(aId);
  const b = await snapshot(bId);

  console.log('스왑 대상:');
  console.log(`  A: ${a.id}  ${a.display_name} / ${a.email}`);
  console.log(`  B: ${b.id}  ${b.display_name} / ${b.email}`);
  console.log('');
  console.log('After:');
  console.log(`  A → ${b.display_name} / ${b.email}`);
  console.log(`  B → ${a.display_name} / ${a.email}`);
  console.log('\n3초 후 시작.');
  await new Promise((r) => setTimeout(r, 3000));

  const tmpEmail = `swap-tmp-${a.id}@haru.test`;

  // 1) A 임시 이메일 (display_name 은 일단 그대로)
  console.log(`\n[1/3] A → 임시 ${tmpEmail}`);
  await setEmailAndName(a.id, tmpEmail, a.display_name);

  // 2) B 를 A 의 원래 이메일/이름으로
  console.log(`[2/3] B → ${a.email} / ${a.display_name}`);
  await setEmailAndName(b.id, a.email, a.display_name);

  // 3) A 를 B 의 원래 이메일/이름으로
  console.log(`[3/3] A → ${b.email} / ${b.display_name}`);
  await setEmailAndName(a.id, b.email, b.display_name);

  console.log('\n✓ 스왑 완료');
}

main().catch((err) => {
  console.error('Aborted:', err);
  process.exit(1);
});
