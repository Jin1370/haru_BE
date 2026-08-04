// dev seed 계정의 담당 운영자(user_metadata.dev_owner) 지정/해제/조회.
//
// 격리 모델:
//   * 어드민 대시보드는 ADMIN_USERS 의 (아이디, 비밀번호) 로 로그인한다.
//   * 그 운영자는 dev_owner 가 자기 아이디인 dev seed 계정만 목록에서 보고,
//     임퍼소네이션도 그 계정들로만 가능하다 (middleware/auth.ts 에서 강제).
//   * ADMIN_SECRET 단독 로그인은 슈퍼유저 — 소유자와 무관하게 전부 접근.
//   * dev_owner 가 없는 계정은 슈퍼유저에게만 보인다.
//
// 사용:
//   npx tsx scripts/set-dev-owner.ts --list
//   npx tsx scripts/set-dev-owner.ts sejin dev-01@haru.test dev-02@haru.test
//   npx tsx scripts/set-dev-owner.ts --clear dev-01@haru.test

import 'dotenv/config';
import { supabase } from '../src/config/supabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SeedUser = { id: string; email: string | null; metadata: Record<string, unknown> };

async function listSeedUsers(): Promise<SeedUser[]> {
  const out: SeedUser[] = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers 실패: ${error.message}`);
    for (const u of data.users) {
      const metadata = (u.user_metadata ?? {}) as Record<string, unknown>;
      if (metadata.is_dev_seed === true) {
        out.push({ id: u.id, email: u.email ?? null, metadata });
      }
    }
    if (data.users.length < perPage) break;
  }
  return out;
}

function match(user: SeedUser, arg: string): boolean {
  if (UUID_RE.test(arg)) return user.id === arg;
  return (user.email ?? '').toLowerCase() === arg.trim().toLowerCase();
}

async function apply(user: SeedUser, owner: string | null): Promise<void> {
  const next = { ...user.metadata };
  if (owner === null) delete next.dev_owner;
  else next.dev_owner = owner;

  const { error } = await supabase.auth.admin.updateUserById(user.id, { user_metadata: next });
  const label = user.email ?? user.id;
  if (error) {
    console.error(`✗ ${label}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(owner === null ? `✓ ${label}: 담당 해제` : `✓ ${label}: 담당 = ${owner}`);
}

async function main() {
  const args = process.argv.slice(2);
  const seedUsers = await listSeedUsers();

  if (args.includes('--list') || args.length === 0) {
    console.log(`dev seed 계정 ${seedUsers.length}개`);
    for (const u of seedUsers) {
      const owner = typeof u.metadata.dev_owner === 'string' ? u.metadata.dev_owner : '(미지정)';
      console.log(`  ${(u.email ?? u.id).padEnd(24)} → ${owner}`);
    }
    return;
  }

  const clear = args.includes('--clear');
  const rest = args.filter((a) => !a.startsWith('--'));
  const owner = clear ? null : rest.shift() ?? null;
  const targets = rest;

  if (!clear && !owner) {
    console.error('Usage: npx tsx scripts/set-dev-owner.ts <owner> <email|user_id>...');
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error('대상 계정을 하나 이상 지정하세요 (email 또는 user_id).');
    process.exit(1);
  }

  for (const t of targets) {
    const user = seedUsers.find((u) => match(u, t));
    if (!user) {
      console.error(`✗ dev seed 계정을 찾을 수 없습니다: ${t}`);
      process.exitCode = 1;
      continue;
    }
    await apply(user, owner);
  }
}

main();
