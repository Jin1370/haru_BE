// 계정 하드 삭제 전 ElevenLabs 보이스 클론 정리.
//
// mig 049 의 auth.users BEFORE DELETE 트리거가 elevenlabs_voice_id 가 남아있는
// 계정의 삭제를 거부한다. 클론을 지우고 컬럼을 비워야 삭제가 통과한다.
// 실패 시 throw — 호출자는 계정 삭제를 중단해야 한다(고아 클론 방지).

import { supabase } from '../src/config/supabase';
import { deleteVoiceClone } from '../src/services/elevenlabs';

export async function purgeVoiceClone(userId: string): Promise<void> {
  const { data, error } = await supabase
    .from('profiles')
    .select('elevenlabs_voice_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(`profiles 조회 실패: ${error.message}`);

  const voiceId = data?.elevenlabs_voice_id as string | null | undefined;
  if (!voiceId) return;

  try {
    await deleteVoiceClone(voiceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ElevenLabs 클론 삭제 실패 (${voiceId}): ${msg}\n` +
        `  이미 ElevenLabs 에서 지워진 클론이라면 컬럼만 비우고 재실행하세요:\n` +
        `  update profiles set elevenlabs_voice_id = null where id = '${userId}';`,
    );
  }

  const { error: updErr } = await supabase
    .from('profiles')
    .update({ elevenlabs_voice_id: null })
    .eq('id', userId);
  if (updErr) throw new Error(`voice_id 비우기 실패: ${updErr.message}`);

  console.log(`  voice clone removed: ${voiceId}`);
}
