import 'dotenv/config';
import { supabase } from '../src/config/supabase';

async function main() {
  const userId = process.argv[2];
  const targetEmail = process.argv[3] ?? 'test3@estsoft.com';
  if (!userId) {
    console.error('Usage: npx tsx scripts/inspect-user.ts <user_id> [target_email]');
    process.exit(1);
  }

  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
  console.log(JSON.stringify(data.user, null, 2));

  let foundOthers: { id: string; email: string | null }[] = [];
  let page = 1;
  for (;;) {
    const { data: lu, error: luErr } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (luErr) break;
    for (const u of lu.users) {
      if (u.email === targetEmail && u.id !== userId) {
        foundOthers.push({ id: u.id, email: u.email });
      }
    }
    if (lu.users.length < 1000) break;
    page++;
  }
  console.log(`\n같은 이메일 (${targetEmail}) 보유 user:`, foundOthers);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
