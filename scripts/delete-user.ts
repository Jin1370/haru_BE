import 'dotenv/config';
import { supabase } from '../src/config/supabase';

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: npx tsx scripts/delete-user.ts <user_id>');
    process.exit(1);
  }

  // Storage 정리 (photos, voice-intro-audio, voice-messages)
  for (const bucket of ['photos', 'voice-intro-audio', 'voice-messages']) {
    const { data, error } = await supabase.storage.from(bucket).list(userId);
    if (error || !data || data.length === 0) continue;
    const paths = data.map((f) => `${userId}/${f.name}`);
    const { error: rmErr } = await supabase.storage.from(bucket).remove(paths);
    if (rmErr) {
      console.error(`  storage cleanup 실패 (${bucket}): ${rmErr.message}`);
    } else {
      console.log(`  ${bucket}: ${paths.length} files removed`);
    }
  }

  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) {
    console.error('Delete failed:', error.message);
    process.exit(1);
  }
  console.log(`✓ deleted user ${userId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
