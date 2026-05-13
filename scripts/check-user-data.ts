import 'dotenv/config';
import { supabase } from '../src/config/supabase';

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: npx tsx scripts/check-user-data.ts <user_id>');
    process.exit(1);
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, display_name, language, nationality, gender, photos, voice_intro')
    .eq('id', userId)
    .maybeSingle();

  const { count: swipeCount } = await supabase
    .from('swipes')
    .select('id', { count: 'exact', head: true })
    .eq('swiper_id', userId);

  const { count: matchCount } = await supabase
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

  const { count: messageCount } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_id', userId);

  console.log('Profile:', profile ?? '(없음)');
  console.log('Swipes:', swipeCount ?? 0);
  console.log('Matches:', matchCount ?? 0);
  console.log('Messages sent:', messageCount ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
