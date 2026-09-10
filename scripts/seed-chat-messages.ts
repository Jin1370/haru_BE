// 긴 대화방 시드 — 인용 점프(`?around=`) 를 실기기에서 확인하려면 페이지
// 경계를 여러 번 넘는 대화가 필요한데, 손으로 쌓을 수가 없다.
//
// 사용:
//   npx tsx scripts/seed-chat-messages.ts <matchId> [개수=200]
//   npx tsx scripts/seed-chat-messages.ts <matchId> 200 --dry-run
//
// 파이프라인을 안 태운다. 라우트로 보내면 200 × (Gemini 번역 + ElevenLabs TTS)
// 라 비용도 시간도 말이 안 된다. messages 에 직접 INSERT 하되 실제 화면에서
// 정상 메시지로 보이도록 다음을 맞춘다:
//
//   * audio_status='ready' + audio_url=null — TTS 스킵 경로(no-speakable-content)
//     와 같은 모양. 텍스트 전용 메시지로 렌더된다.
//   * listened_at 을 미리 채운다 — 안 채우면 수신자 화면에서 전부 편지 카드로
//     뜨고, ChatBubble 이 자동 청취 마킹 POST 를 개수만큼 쏜다.
//   * created_at 을 과거로 5분 간격 분산 — 페이지네이션과 날짜 구분선이
//     의미 있게 동작한다.
//   * 발신자를 번갈아 — 내/상대 말풍선을 둘 다 확인.
//   * 마지막 메시지가 **가장 오래된 메시지를 인용**한다 (reply_to_id). 방을
//     열자마자 인용을 눌러 점프를 바로 시험할 수 있다.
//
// ⚠️ messages INSERT 마다 match_roundtrip_on_insert 트리거가 fire 해서 친밀도
// 카운트가 개수만큼 올라가고 사진 잠금이 전부 풀린다. **dev seed 계정끼리의
// 매치에서만** 돌릴 것 (본인 실계정 매치에 쓰면 그 방의 잠금 상태가 망가진다).
//
// 정리:
//   시드한 메시지만 지우려면 아래 SQL (Dashboard SQL Editor):
//     DELETE FROM messages WHERE match_id = '<matchId>' AND original_text LIKE '[seed]%';

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { supabase } from '../src/config/supabase';

const MARKER = '[seed]';
const INTERVAL_MINUTES = 5;
const BATCH = 100;

interface Row {
  id: string;
  match_id: string;
  sender_id: string;
  original_text: string;
  original_language: string;
  translated_text: string | null;
  translated_language: string | null;
  audio_url: null;
  audio_status: 'ready';
  listened_at: string;
  reply_to_id: string | null;
  created_at: string;
}

async function main(): Promise<void> {
  const [matchId, countArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  const count = Number(countArg ?? 200);

  if (!matchId) {
    console.error('usage: npx tsx scripts/seed-chat-messages.ts <matchId> [개수=200] [--dry-run]');
    process.exit(1);
  }
  if (!Number.isInteger(count) || count < 2 || count > 1000) {
    console.error('개수는 2~1000 사이 정수여야 한다.');
    process.exit(1);
  }

  const { data: match, error: matchError } = await supabase
    .from('matches')
    .select('id, user1_id, user2_id')
    .eq('id', matchId)
    .maybeSingle();
  if (matchError) {
    console.error('매치 조회 실패:', matchError.message);
    process.exit(1);
  }
  if (!match) {
    console.error(`매치를 찾을 수 없다: ${matchId}`);
    process.exit(1);
  }

  const participants = [match.user1_id as string, match.user2_id as string];

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, display_name, language')
    .in('id', participants);
  if (profileError) {
    console.error('프로필 조회 실패:', profileError.message);
    process.exit(1);
  }

  const langOf = new Map<string, string>(
    (profiles ?? []).map((p) => [p.id as string, (p.language as string) ?? 'ko']),
  );
  for (const p of profiles ?? []) {
    console.log(`  참여자: ${p.display_name} (${p.language}) ${p.id}`);
  }

  // 가장 오래된 것부터 쌓아 올린다 — 마지막(최신) 메시지가 첫 메시지를 인용한다.
  const now = Date.now();
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const senderId = participants[i % 2];
    const recipientId = participants[(i + 1) % 2];
    const minutesAgo = (count - i) * INTERVAL_MINUTES;
    rows.push({
      id: randomUUID(),
      match_id: matchId,
      sender_id: senderId,
      original_text: `${MARKER} 테스트 메시지 #${i + 1}`,
      original_language: langOf.get(senderId) ?? 'ko',
      // 인용문이 뷰어 언어로 나오는지 보려면 번역문도 있어야 한다.
      translated_text: `${MARKER} test message #${i + 1}`,
      translated_language: langOf.get(recipientId) ?? 'en',
      audio_url: null,
      audio_status: 'ready',
      // 수신자가 이미 들은 것으로 — 안 그러면 전부 편지 카드 + 자동 마킹 폭주.
      listened_at: new Date(now - minutesAgo * 60_000 + 1000).toISOString(),
      reply_to_id: null,
      created_at: new Date(now - minutesAgo * 60_000).toISOString(),
    });
  }
  // 마지막 메시지가 맨 처음 메시지를 인용 — 방 열자마자 점프를 시험할 수 있다.
  rows[rows.length - 1].reply_to_id = rows[0].id;
  rows[rows.length - 1].original_text = `${MARKER} 이 인용을 눌러 #1 로 점프`;

  console.log(
    `\n${count}건 / ${INTERVAL_MINUTES}분 간격 / ${new Date(rows[0].created_at).toLocaleString()} ~ ${new Date(rows[rows.length - 1].created_at).toLocaleString()}`,
  );
  console.log(`마지막 메시지가 #1(${rows[0].id}) 을 인용한다.`);

  if (dryRun) {
    console.log('\n--dry-run — INSERT 안 함.');
    return;
  }

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await supabase.from('messages').insert(slice);
    if (error) {
      console.error(`INSERT 실패 (${i}~${i + slice.length}):`, error.message);
      process.exit(1);
    }
    console.log(`  INSERT ${i + slice.length}/${rows.length}`);
  }

  console.log('\n완료. 트리거가 fire 했으므로 이 매치의 친밀도/사진 잠금 상태는 바뀌었다.');
  console.log(`정리: DELETE FROM messages WHERE match_id = '${matchId}' AND original_text LIKE '${MARKER}%';`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
