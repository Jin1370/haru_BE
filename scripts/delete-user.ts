import 'dotenv/config';
import { supabase } from '../src/config/supabase';
import { purgeUserFolders, purgeUserVoiceMessages } from '../src/services/storage';
import { purgeVoiceClone } from './purge-voice-clone';

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: npx tsx scripts/delete-user.ts <user_id>');
    process.exit(1);
  }

  // 보이스 클론 정리 — auth.users 삭제 시 profiles 가 CASCADE 로 먼저 사라져
  // voice_id 를 잃어버리므로 반드시 삭제 *전* 에 지운다. 실패하면 throw 되어
  // 계정 삭제까지 도달하지 않는다(mig 049 트리거도 같은 조건으로 이중 방어).
  await purgeVoiceClone(userId);

  // 음성 메시지 — 계정 삭제 시 매치 CASCADE 로 messages 행이 사라져 경로를 잃는다.
  // 반드시 삭제 *전* 에.
  console.log(`  voice-messages: ${await purgeUserVoiceMessages(userId)} files removed`);

  // 사진(평면/originals/converted) + 보이스 한마디
  console.log(`  photos + voice-intro-audio: ${await purgeUserFolders(userId)} files removed`);

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
