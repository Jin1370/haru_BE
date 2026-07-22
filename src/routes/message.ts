import { Router, Response } from 'express';
import * as Sentry from '@sentry/node';
import { supabase } from '../config/supabase';
import { uploadFile } from '../services/storage';
import { synthesizeSpeech, type PersonaGender } from '../services/elevenlabs';
import { translateMessage } from '../services/translation';
import {
  replaceTagsForDisplay,
  ensureSpeakableForTTS,
  hasSpeakableContent,
  stripNonAudibleTags,
} from '../utils/textNormalization';
import { authMiddleware } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { sendMessageSchema, messageQuerySchema } from '../schemas/message';
import { AuthRequest, Emotion } from '../types';
import { sendPushToUser } from '../services/pushNotifications';
import { isBlocked } from '../constants/moderationDictionary';
import { checkOpenAiModeration } from '../services/openaiModeration';
import { requireNotFrozen } from '../utils/freezeGuard';
import { logModerationBlock } from '../utils/moderationAudit';
import { randomUUID } from 'crypto';

const router = Router();

router.use(authMiddleware);

// idempotent-send: 같은 messageId 파이프라인 동시/중복 실행 방지 (per-instance).
// 목적은 correctness 가 아니라 COST (이중 TTS/번역 방지) — correctness 는 최종
// INSERT 의 ON CONFLICT (id) DO NOTHING 이 보장한다. Fly 다중 머신에서 재시도가
// 다른 머신에 착지하면 이 Set 은 못 잡지만, 그 경우도 두 파이프라인이 같은 id 로
// INSERT → 두 번째는 DO NOTHING → row/푸시/전달 단일. 낭비되는 건 ElevenLabs 합성
// 1회 + Storage 덮어쓰기(같은 path `${messageId}.mp3`, orphan 없음)뿐이다.
// 크로스-인스턴스 이중 합성까지 막으려면 DB idempotency marker 필요 — v1 미포함(P1).
const inFlightMessages = new Set<string>();

export function beginProcessing(id: string): boolean {
  if (inFlightMessages.has(id)) return false;
  inFlightMessages.add(id);
  return true;
}

export function endProcessing(id: string): void {
  inFlightMessages.delete(id);
}

type MessageRow = Record<string, unknown>;

// idempotent-send: INSERT ... ON CONFLICT (id) DO NOTHING 후 scoped 재반환.
//
//   * inserted=true  — 이번 호출이 실제로 row 를 삽입했다 (신규).
//   * inserted=false, row!=null — id 충돌(DO NOTHING). 기존 row 가 (id AND match_id
//     AND sender_id) 로 내 소유임을 확인하고 그대로 재반환 (멱등 재전송).
//   * conflict=true (row=null) — id 는 전역에 존재하나 내 (match+sender) 소유가
//     아님 = 위조/타인 id → 내용 미노출, 호출처가 409.
//   * row=null, conflict=false — supabase 에러 → 호출처가 500.
//
// R1 (IDOR) 방어의 핵심: 재반환 SELECT 는 반드시 id AND match_id AND sender_id 로
// scope 한다. 미scoped SELECT 는 남의 매치 메시지 UUID probe → 원문 유출.
async function idempotentInsertMessage(
  payload: Record<string, unknown>,
  matchId: string,
  senderId: string,
): Promise<{ row: MessageRow | null; inserted: boolean; conflict: boolean }> {
  const { data: insertedRows, error } = await supabase
    .from('messages')
    .upsert(payload, { onConflict: 'id', ignoreDuplicates: true })
    .select();

  if (error) {
    console.error(`[idempotentInsertMessage] upsert failed id=${payload.id}:`, error.message);
    return { row: null, inserted: false, conflict: false };
  }
  if (insertedRows && insertedRows.length > 0) {
    return { row: insertedRows[0] as MessageRow, inserted: true, conflict: false };
  }

  // 0 rows = id 충돌 (DO NOTHING). scoped 로만 재반환.
  const { data: existing, error: selectError } = await supabase
    .from('messages')
    .select('*')
    .eq('id', payload.id as string)
    .eq('match_id', matchId)
    .eq('sender_id', senderId)
    .maybeSingle();

  if (selectError) {
    console.error(`[idempotentInsertMessage] scoped re-select failed id=${payload.id}:`, selectError.message);
    return { row: null, inserted: false, conflict: false };
  }
  if (existing) {
    return { row: existing as MessageRow, inserted: false, conflict: false };
  }
  // 충돌했으나 내 (match+sender) 소유가 아님 → 위조/타인 id → 내용 미노출.
  return { row: null, inserted: false, conflict: true };
}

// 메시지 목록 (페이지네이션)
router.get('/:matchId/messages', validateQuery(messageQuerySchema), async (req: AuthRequest, res: Response) => {
  const { matchId } = req.params;
  const limit = req.query.limit as unknown as number;
  const before = req.query.before as string | undefined;

  // 매치에 속한 유저인지 확인
  const { data: match } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .or(`user1_id.eq.${req.userId!},user2_id.eq.${req.userId!}`)
    .single();

  if (!match) {
    res.status(403).json({ error: 'Not a member of this match' });
    return;
  }

  // voice-first-message-gate sprint follow-up: 수신자에게는 audio_status='ready'
  // 메시지만 노출한다. failed/pending(voice-clone 미보유 발신자) 메시지는 청취
  // 자체가 불가능 → listened_at 영구 NULL → "메시지 준비 중.." 문구가 영구 락
  // 신호로 굳어지는 거짓 신호 문제 해결. 본인 발신 메시지는 status 무관하게
  // 노출 — 본인은 본인 메시지를 알아야 재전송 등 대응 가능. 별도 송신자 측
  // 실패 인디케이터는 후속 카드로 분리.
  let query = supabase
    .from('messages')
    .select('*')
    .eq('match_id', matchId)
    .or(`sender_id.eq.${req.userId!},audio_status.eq.ready`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt('created_at', before);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// 메시지 전송 (번역 + 더빙 파이프라인)
//
// chat-audio-async-insert sprint: 본 라우트는 더 이상 텍스트만 먼저 INSERT
// 한 뒤 비동기로 UPDATE 하지 않는다. 7라운드 진단으로 expo-audio 1.1.x 의
// mid-session player resource 자동 회수 동작이 root cause 임이 확정됐고,
// FE-only fix 6번이 모두 우회 실패했기 때문에 mid-session UPDATE 패턴 자체를
// 제거한다. 새 모델:
//
//   1. 본 핸들러는 즉시 stub 응답 (id=`pending-<uuid>`, audio_status='pending').
//      DB INSERT 안 함. FE 가 optimistic 으로 표시.
//   2. processMessageAudio 가 비동기로 번역 + TTS + Storage 업로드 후
//      **마지막에 한 번만** messages.INSERT — audio_status 가 'ready' (성공)
//      또는 'failed' (실패) 로 확정된 상태로 저장. realtime INSERT 가
//      한 번만 발생 → expo-audio 의 cold-start path 만 거치게 됨.
//   3. 014c AFTER INSERT 트리거 (matches roundtrip 갱신) 는 INSERT 시점에
//      fire — 송신자가 보는 친밀도 게이지 갱신이 5~10초 지연됨. UX 트레이드
//      오프. realtime matches UPDATE 채널로 양쪽 피어 동시 갱신.
//   4. send 응답에 match_after 동봉하지 않음 (INSERT 자체가 안 일어남).
//      FE 는 realtime matches UPDATE 채널을 단일 진실원으로 사용.
//   5. retry 라우트 제거. 실패 메시지는 audio_url=null 인 텍스트 전용으로
//      INSERT 되며, 사용자가 메시지를 다시 입력해 재송신. DELETE/UPDATE 트리거
//      간섭이 없어 가장 안전.
router.post('/:matchId/messages', requireNotFrozen, validateBody(sendMessageSchema), async (req: AuthRequest, res: Response) => {
  const matchId = req.params.matchId as string;
  const { text, emotion, client_message_id } = req.body as
    { text: string; emotion?: Emotion; client_message_id?: string };
  // neutral = "태그 없음" — DB에는 null로 저장 (CHECK constraint도 neutral 제외)
  const storedEmotion: Exclude<Emotion, 'neutral'> | null =
    emotion && emotion !== 'neutral' ? emotion : null;

  // 매치 확인 + 상대방 정보 조회
  const { data: match } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .or(`user1_id.eq.${req.userId!},user2_id.eq.${req.userId!}`)
    .single();

  if (!match) {
    res.status(403).json({ error: 'Not a member of this match' });
    return;
  }

  // 언매치 확인
  if (match.unmatched_at) {
    res.status(403).json({ error: 'This match has been unmatched' });
    return;
  }

  const recipientId = match.user1_id === req.userId! ? match.user2_id : match.user1_id;

  // 차단 여부 확인. 본 시점 (queue 시점) 에 차단을 검증하므로 비동기
  // pipeline 중간에 차단이 걸려도 메시지가 새어나가지 않는다. 단,
  // POST 가 통과한 후 ~5초 사이 차단이 추가되면 메시지가 INSERT 된다.
  // 차단 시점에 매치도 자동 unmatched 처리되므로 사용자 UX 영향 미미.
  const { data: blocked } = await supabase
    .from('blocks')
    .select('id')
    .or(`and(blocker_id.eq.${req.userId!},blocked_id.eq.${recipientId}),and(blocker_id.eq.${recipientId},blocked_id.eq.${req.userId!})`)
    .limit(1);

  if (blocked && blocked.length > 0) {
    res.status(403).json({ error: 'Cannot send message to blocked user' });
    return;
  }

  // 발신자/수신자 프로필 조회 (mig 009 이후 단일 scalar `language` 사용)
  // push-notifications sprint: sender_name 푸시 페이로드용 display_name 동시 조회.
  // gender 는 elevenlabs.synthesizeSpeech 의 persona tag 분기에 사용.
  const [senderResult, recipientResult] = await Promise.all([
    supabase.from('profiles').select('language, elevenlabs_voice_id, display_name, gender').eq('id', req.userId!).single(),
    supabase.from('profiles').select('language').eq('id', recipientId).single(),
  ]);

  const sender = senderResult.data;
  const recipient = recipientResult.data;
  const senderLang = (sender?.language as string | null) ?? null;
  const recipientLang = (recipient?.language as string | null) ?? null;
  const senderName = (sender?.display_name as string | null) ?? '';
  // 메시지 TTS persona: 'female' 은 voice intro 에서만 사용하고 메시지에선 제외.
  // 이유: 매 메시지 [sweetly, smiling] 누적 시 톤이 단조로워지고 캐릭터가 과장됨.
  // 'male' 의 [warm, gently] 는 baseline 안정성 보조라 유지.
  const rawGender = (sender?.gender as PersonaGender) ?? null;
  const senderGender: PersonaGender = rawGender === 'female' ? null : rawGender;

  if (!sender || !recipient || !senderLang || !recipientLang) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  // message-moderation-v1 (PR1): 사전 키워드 차단 — TTS·번역 비동기 큐 도달 전.
  //
  // 차별점 2 (클론 보이스 TTS) 의 가장 큰 평판 리스크 (노골 표현 합성 → 캡처/유출)
  // 를 송신 시점에 차단. normalize(NFKC + 가타카나→히라가나 + 한글 자모 결합) 후
  // substring contains 매칭. 위치는 매치/차단 검증 뒤 + queueing 직전 — 매치 자체가
  // 없는 사용자가 차단 정책을 probe 하는 경로 차단 (먼저 403).
  //
  // 응답: 422 + code: 'message_blocked'. 카테고리/매칭 토큰은 응답에 노출 ❌
  // (송신자가 우회 패턴 학습 차단). FE 는 `code` 매칭으로 i18n 토스트 노출.
  //
  // 부수효과:
  //   1) console.warn 으로 즉시 운영 가시성 — 사전/우회 패턴 튜닝의 1차 신호원.
  //      메시지 원문은 절대 로그 ❌ (PIPA/GDPR + 사쿠라 의혹 회피).
  //   2) moderation_blocks 테이블에 fire-and-forget INSERT — DB audit log.
  //      mig 020. INSERT 실패해도 응답 막지 않음 (push-notifications fire-and-
  //      forget 패턴 동일). 카테고리 + 언어 + sender_id + blocked_at 만 보존,
  //      원문/매칭 토큰/매치 id 미보존 (사용자 결정 PR1 스키마).
  const moderationResult = isBlocked(text);
  if (moderationResult.blocked) {
    logModerationBlock({
      senderId: req.userId!,
      category: moderationResult.category!,
      language: moderationResult.language!,
      layer: 'dictionary',
      surface: 'message',
    });
    res.status(422).json({
      error: 'Message contains restricted expressions',
      code: 'message_blocked',
    });
    return;
  }

  // message-moderation-v1 follow-up (B 안, 2026-05-18): OpenAI Moderation 2차 검수.
  // 사전 차단 통과 메시지를 omni-moderation-latest 로 보내 우회 / 그루밍 / 스캠
  // 패턴 차단. 응답 shape 는 사전 차단과 정확히 동일 (422 + code='message_blocked'
  // + category 미노출) — FE 핸들러 무변경. audit log 도 같은 테이블 (layer 컬럼은
  // moderation_blocks v1 스키마에 없으므로 console 로그에만 layer='openai' 가시화).
  // fail-open: 키 미설정 / OpenAI 다운 시 통과 (사전 차단이 1차 방어선).
  const openaiResult = await checkOpenAiModeration(text);
  if (openaiResult.blocked) {
    // OpenAI 는 multi-lingual 모델이라 language 단정 어려움 — 송신자
    // profiles.language 를 fallback (omni-moderation-latest 는 language 미명시).
    logModerationBlock({
      senderId: req.userId!,
      category: openaiResult.category!,
      language: senderLang ?? 'ko',
      layer: 'openai',
      surface: 'message',
      rawCategory: openaiResult.rawCategory,
    });
    res.status(422).json({
      error: 'Message contains restricted expressions',
      code: 'message_blocked',
    });
    return;
  }

  // queueing 시점에 message id + created_at 을 미리 확정. created_at 을
  // 이 시점에 고정하는 이유는 비동기 TTS 가 메시지마다 다른 시간을 잡아
  // 늦게 보낸 메시지가 먼저 INSERT 되는 순서 역전을 막기 위함. INSERT 시
  // `created_at` 컬럼에 이 값을 명시 → ORDER BY created_at 이 send 순서.
  // idempotent-send: 클라이언트가 멱등 키를 제공하면 그 값을 messages.id 로 사용,
  // 미제공 시 서버 randomUUID() 폴백 (옛 FE 하위호환). client_message_id 는 이미
  // sendMessageSchema 의 .uuid() 검증을 통과했다. 이 messageId 로 ON CONFLICT (id)
  // DO NOTHING 을 걸어 응답 유실 후 재전송 시에도 row/TTS/전달이 단일이 되게 한다.
  // 멱등 키는 match/unmatch/block/profile/모더레이션 검증 뒤에서 사용되므로 매치
  // 없는 사용자의 정책 probe 방어는 그대로 유지된다 (검증 순서 불변).
  const messageId = client_message_id ?? randomUUID();
  const queuedAt = new Date().toISOString();
  const voiceId = sender.elevenlabs_voice_id ?? null;

  // voice clone 없는 발신자는 mid-session UPDATE 가 발생할 수 없는 경로
  // (audio_status 전이가 일어나지 않음). 동기 INSERT 후 응답 — UX 가 가장
  // 단순하고 회귀 위험 최소.
  if (!voiceId) {
    // idempotent-send: 동기 경로도 ON CONFLICT (id) DO NOTHING + scoped 재반환.
    // 응답 유실 후 같은 client_message_id 로 재전송 시 신규는 201, 재전송은 200
    // (동일 row), 위조/타인 id 는 409 (내용 미노출). row=null 은 500.
    const { row, inserted, conflict } = await idempotentInsertMessage(
      {
        id: messageId,
        match_id: matchId,
        sender_id: req.userId!,
        original_text: text,
        original_language: senderLang,
        translated_text: null,
        translated_language: recipientLang,
        audio_url: null,
        audio_status: 'pending',
        emotion: storedEmotion,
        created_at: queuedAt,
      },
      matchId,
      req.userId!,
    );
    if (conflict) {
      res.status(409).json({ error: 'Message id already used', code: 'duplicate_message' });
      return;
    }
    if (!row) {
      res.status(500).json({ error: 'Message insert failed' });
      return;
    }
    res.status(inserted ? 201 : 200).json(row);

    // push-notifications sprint: 동기 INSERT 경로 (voice-clone 미보유 발신자) 의
    // 푸시 발송. INSERT 가 'pending' 상태로 저장되지만 voice-first-message-gate
    // 정책상 수신자 GET 에서 필터링되어 안 보이는 메시지 — 푸시도 보내지 않는다.
    // (failed 메시지와 같은 정합성: "수신자에게 안 보이는 메시지 = 푸시 미발송")
    // 사실상 voice clone 미보유 발신자의 메시지는 푸시 미발송 분기.
    return;
  }

  // idempotent-send: async 경로 pre-check (voiceId 보유자만 통과 + 회피 비용(TTS
  // 합성)이 커서 정당 — 동기 경로엔 이 pre-check 없음).
  //
  // 1) retry-after-commit 감지 — 이미 INSERT 된 (내 소유) row 면 재합성 없이 그대로
  //    반환. scoped(id+match+sender) 라 위조 id 는 여기서 안 걸리고 아래로 흘러 409.
  const { data: committed, error: committedError } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .eq('match_id', matchId)
    .eq('sender_id', req.userId!)
    .maybeSingle();
  if (committedError) {
    // pre-check 실패는 correctness 를 깨지 않는다 (최종 upsert 의 ON CONFLICT 가
    // 보장) — 가시화만 하고 정상 전송 흐름으로 통과시켜 핫패스 회복력 유지.
    console.error(`[POST messages] committed pre-check failed id=${messageId}:`, committedError.message);
  }
  if (committed) {
    res.status(200).json(committed);
    return;
  }

  // 2) 위조 id 조기 차단 — 내 소유 아닌 기존 id 로 in-flight 시작/재합성 방지.
  //    (전역 id 존재하나 scoped 로 안 잡히면 → 409, 파이프라인 미발화)
  const { data: foreign, error: foreignError } = await supabase
    .from('messages')
    .select('id')
    .eq('id', messageId)
    .maybeSingle();
  if (foreignError) {
    console.error(`[POST messages] foreign pre-check failed id=${messageId}:`, foreignError.message);
  }
  if (foreign) {
    res.status(409).json({ error: 'Message id already used', code: 'duplicate_message' });
    return;
  }

  // voice clone 있는 발신자만 async INSERT 경로. 즉시 stub 응답 (id 가
  // 확정된 UUID 이므로 realtime INSERT 가 도착하면 FE 가 같은 id 로 replace).
  // audio_status='pending' 은 stub 표식이며 진짜 INSERT 는 'ready' 또는
  // 'failed' 로 확정된 상태로만 일어난다 — mid-session UPDATE 자체가 없음.
  res.status(202).json({
    id: messageId,
    match_id: matchId,
    sender_id: req.userId!,
    original_text: text,
    original_language: senderLang,
    translated_text: null,
    translated_language: recipientLang,
    audio_url: null,
    audio_status: 'pending',
    emotion: storedEmotion,
    created_at: queuedAt,
  });

  // idempotent-send: in-flight 가드 후 파이프라인 fire. 같은 인스턴스에서 같은
  // messageId 로 동시/중복 요청이 오면 두 번째부터 beginProcessing 이 false 를
  // 반환해 파이프라인(TTS/번역) 재실행을 건너뛴다. finally 의 endProcessing 이
  // 완료 후 Set 에서 제거. (크로스-인스턴스 재시도는 최종 ON CONFLICT 가 커버.)
  if (beginProcessing(messageId)) {
    processAndInsertMessage({
      messageId,
      matchId,
      senderId: req.userId!,
      senderName,
      senderGender,
      recipientId,
      text,
      senderLang,
      recipientLang,
      emotion: storedEmotion,
      voiceId,
      queuedAt,
    }).catch((err) => console.error('[processAndInsertMessage unhandled]', err));
  }
});

// read-at-removal-list-mask sprint: PATCH /:matchId/messages/read 라우트 제거.
//
// "읽음" 의 의미를 listened_at (음성 청취 완료) 으로 일원화하면서 read_at 컬럼이
// 사라졌고, 채팅방 진입 시 일괄 읽음 처리 동선 자체가 무의미해졌다. 메시지별
// listened 마킹은 `POST /:matchId/messages/:messageId/listened` 로 단일 진실원
// 유지 — 수신자가 음성을 끝까지 재생한 메시지만 read 로 간주된다.

// voice-first-message-gate sprint: 수신자가 메시지 음성을 1회 끝까지 재생했음을
// 서버에 기록. idempotent — 이미 listened_at 가 set 되어 있으면 현 row 그대로
// 반환. 송신자 본인이 호출하면 403 (본인은 게이팅 대상이 아니므로 잘못된 호출).
// 다른 매치/존재하지 않는 메시지 시도 시 404.
//
// 본 라우트는 chat-audio-async-insert 의 "mid-session UPDATE 금지" 원칙의 예외
// 이지만, listened_at 한 컬럼에 한정되며 audio_status / audio_url 은 절대 건드리지
// 않는다 → expo-audio resource 회수 트리거와 무관.
router.post('/:matchId/messages/:messageId/listened', async (req: AuthRequest, res: Response) => {
  const { matchId, messageId } = req.params;

  // 1) 매치 참여자 검증 (기존 GET/POST 와 동일 패턴)
  const { data: match } = await supabase
    .from('matches')
    .select('id')
    .eq('id', matchId)
    .or(`user1_id.eq.${req.userId!},user2_id.eq.${req.userId!}`)
    .single();

  if (!match) {
    res.status(403).json({ error: 'Not a member of this match' });
    return;
  }

  // 2) 메시지 조회 + match_id 정합성 검증
  const { data: msg, error: selectError } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .eq('match_id', matchId)
    .single();

  if (selectError || !msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  // 3) 송신자 본인 호출 차단 — 본인은 게이팅 대상이 아니므로 잘못된 호출.
  if (msg.sender_id === req.userId!) {
    res.status(403).json({ error: 'Sender cannot mark own message as listened' });
    return;
  }

  // 4) Idempotent — 이미 listened 상태면 현재 row 그대로 반환.
  if (msg.listened_at) {
    res.json(msg);
    return;
  }

  // 5) listened_at = now() 단일 컬럼 UPDATE.
  //    조건절에 listened_at IS NULL 을 포함해 동시 호출(여러 기기) 시에도 가장
  //    빠른 한 번만 실제 UPDATE 한다. 이미 set 된 후 도착한 UPDATE 는 0 rows
  //    affected → .single() 이 실패 → refresh select 분기로 idempotent 보장.
  const { data: updated, error: updateError } = await supabase
    .from('messages')
    .update({ listened_at: new Date().toISOString() })
    .eq('id', messageId)
    .is('listened_at', null)
    .select()
    .single();

  if (updateError || !updated) {
    // 동시 UPDATE 로 row 가 이미 set 되어 .single() 이 0 rows 로 실패한 경우
    // → 재 SELECT 후 반환. 단, refreshed.listened_at 가 여전히 NULL 이면 진짜
    // UPDATE 실패 (예: 마이그레이션 미적용으로 컬럼이 없는 schema drift) 이므로
    // silent-success 로 가리지 않고 500 반환. QA 검증 단계에서 발견된 회귀
    // 시나리오 — 라이브 DB 에 컬럼이 없는데 200 으로 응답되던 케이스 차단.
    const { data: refreshed } = await supabase
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .single();
    if (refreshed && refreshed.listened_at) {
      res.json(refreshed);
      return;
    }
    res.status(500).json({ error: updateError?.message ?? 'Listened update failed' });
    return;
  }

  res.json(updated);
});

// chat-audio-async-insert sprint: retry 라우트 제거.
//
// 이전 구조에서는 failed 메시지를 audio_status='processing' 으로 UPDATE 한 뒤
// 재합성 후 다시 audio_status='ready' 로 UPDATE 했다. 본 sprint 가 mid-session
// UPDATE 패턴 자체를 제거하므로 같은 messageId 의 status 전이 자체가 사라진다.
// 실패한 메시지는 audio_url=null 인 텍스트 전용으로 영구 INSERT 되며, 사용자가
// 동일 텍스트로 새 메시지를 보내 재시도한다. 14c roundtrip 트리거가 AFTER
// INSERT 만 fire 하므로 DELETE 기반 재시도는 카운터 불일치를 만들 수 있어
// 더 위험. 텍스트 재송신이 가장 안전한 경로.

// audio-expiry sprint: 청취 + 30일 경과로 sweep 이 폐기한 음성을 ElevenLabs 로
// on-demand 재합성. 매치 멤버 누구나 호출 가능 (송신자/수신자 모두 본인 화면에서
// 재청취 가능해야 함). 다음 조건을 모두 만족해야 200:
//   * 매치 멤버 (그 외 403)
//   * 메시지가 해당 매치에 속함 (그 외 404)
//   * audio_status='ready' AND audio_purged_at IS NOT NULL — 본 메시지가 원래
//     음성이 있었고 sweep 으로 폐기된 상태 (그 외 409 — 텍스트 전용 메시지
//     또는 아직 폐기 안 된 메시지에 대한 부정 호출 차단)
//   * 송신자의 현재 elevenlabs_voice_id 가 존재 (그 외 410 — 송신자가 클론을
//     소실한 경우. 탈퇴 anonymize / 미보유 등)
//
// 재합성 파이프라인은 processAndInsertMessage 와 동일 구조 (Gemini 태깅+번역 →
// synthesizeSpeech → uploadFile) 이나, INSERT 가 아니라 UPDATE 라는
// 점만 다름. 재생성된 audio 는 versioned path (`{messageId}_v{ts}.mp3`) 로 업로드
// 해 CDN/클라이언트 캐시 우회 — 동일 path 에 upsert 하면 일부 클라이언트가
// 옛 404 응답을 캐시했을 때 새 파일을 못 가져오는 회귀 발생.
//
// 사용자가 클론을 재녹음했다면 voice_id 가 옛 발신 시점과 다를 수 있다 — 의도된
// 트레이드오프 (재녹음 = 사용자가 자기 목소리 변경을 명시 동의). UX 영향 미미.
router.post('/:matchId/messages/:messageId/audio', requireNotFrozen, async (req: AuthRequest, res: Response) => {
  const { matchId, messageId } = req.params;

  // 1) 매치 멤버 검증
  const { data: match } = await supabase
    .from('matches')
    .select('id, unmatched_at')
    .eq('id', matchId)
    .or(`user1_id.eq.${req.userId!},user2_id.eq.${req.userId!}`)
    .single();

  if (!match) {
    res.status(403).json({ error: 'Not a member of this match' });
    return;
  }

  // unmatched 매치도 재생성 허용 — 채팅 종료 tombstone 화면에서 옛 메시지를 다시
  // 들을 수 있도록 (UX: 이별 후 메시지 회상). 별도 정책 변경 원하면 여기서 차단.

  // 2) 메시지 조회 + 매치 정합성
  const { data: msg, error: selectError } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .eq('match_id', matchId)
    .single();

  if (selectError || !msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  // 3) 재생성 가능 상태 검증 — audio_purged_at IS NOT NULL 인 경우만 허용.
  // 텍스트 전용 메시지 / no-speakable-content / failed 메시지에 대한 부정 호출
  // 차단. audio_status='ready' 도 함께 체크해 sweep 이 잘못된 상태에 마킹한
  // 행이 있어도 안전.
  if (msg.audio_status !== 'ready' || !msg.audio_purged_at) {
    res.status(409).json({ error: 'Message audio is not in a regeneratable state' });
    return;
  }

  // 4) 송신자 프로필 — 현재 voice clone + gender + language 조회. 메시지의
  // original_language 가 truth source 이지만 gender persona / voice_id 는 현재
  // 시점의 sender 프로필을 사용한다 (재녹음했을 수 있음).
  const { data: sender } = await supabase
    .from('profiles')
    .select('elevenlabs_voice_id, gender')
    .eq('id', msg.sender_id)
    .single();

  const voiceId = (sender?.elevenlabs_voice_id as string | null) ?? null;
  if (!voiceId) {
    // 송신자가 클론 소실 — 탈퇴 anonymize 또는 voice 미보유. 재합성 불가.
    res.status(410).json({ error: 'Sender voice clone unavailable' });
    return;
  }

  const rawGender = (sender?.gender as PersonaGender) ?? null;
  const senderGender: PersonaGender = rawGender === 'female' ? null : rawGender;

  const originalText = msg.original_text as string;
  const senderLang = msg.original_language as string;
  const recipientLang = (msg.translated_language as string | null) ?? senderLang;
  const emotion = (msg.emotion as Exclude<Emotion, 'neutral'> | null) ?? null;

  // 5) 파이프라인 — 본 라우트는 동기 응답이 필요 (FE 가 받은 URL 로 즉시 재생)
  // 이라 async stub 패턴 적용 안 함. 일반적으로 < 5초.
  try {
    const { translation } = await translateMessage({
      text: originalText,
      targetLanguage: recipientLang,
    });

    // [laughs] 만 audible — [sad] 등은 TTS 에서 제거 (사용자 정책).
    const ttsText = stripNonAudibleTags(translation);
    if (!hasSpeakableContent(ttsText)) {
      // 원래도 TTS 가 스킵됐어야 할 케이스 — 재합성 불가. 일반적으로 도달 안 함
      // (sweep 이 audio_url NOT NULL 인 row 만 노렸기 때문). 방어적 분기.
      res.status(409).json({ error: 'Message has no speakable content' });
      return;
    }

    const textToSynthesize = ensureSpeakableForTTS(ttsText);
    const audio = await synthesizeSpeech(
      textToSynthesize,
      voiceId,
      emotion,
      senderGender,
      recipientLang,
    );

    // CDN 캐시 회피용 versioned path. 원본 `{messageId}.mp3` 는 sweep 이 이미
    // 삭제했고, 같은 path 에 upsert 하면 일부 클라이언트가 옛 404 응답을
    // 캐시한 경우 새 파일을 못 가져온다.
    const versionedPath = `${messageId}_v${Date.now()}.mp3`;
    const audioUrl = await uploadFile('voice-messages', versionedPath, audio, 'audio/mpeg');

    // 6) DB UPDATE — audio_url 새 값 + audio_purged_at NULL + audio_refreshed_at
    // now(). audio_status 는 'ready' 유지 (재합성 자체가 ready 상태에서만 가능).
    const { data: updated, error: updateError } = await supabase
      .from('messages')
      .update({
        audio_url: audioUrl,
        audio_purged_at: null,
        audio_refreshed_at: new Date().toISOString(),
      })
      .eq('id', messageId)
      .select()
      .single();

    if (updateError || !updated) {
      // Storage 에는 객체가 올라갔는데 DB 만 실패 — 다음 sweep 사이클에서 orphan
      // 정리 (Storage 객체는 audio_url 컬럼에 매핑되지 않은 상태로 잔존하므로
      // sweep 이 못 잡음). 운영 신호로 노출.
      console.error(`[regenAudio] DB update failed messageId=${messageId} path=${versionedPath}:`, updateError?.message);
      res.status(500).json({ error: updateError?.message ?? 'Audio regenerate update failed' });
      return;
    }

    res.json(updated);
  } catch (error) {
    console.error(`[regenAudio] pipeline error messageId=${messageId}:`, error);
    res.status(502).json({ error: 'Audio regeneration failed' });
  }
});

interface ProcessJob {
  messageId: string;
  matchId: string;
  senderId: string;
  senderName: string;
  senderGender: PersonaGender;
  recipientId: string;
  text: string;
  senderLang: string;
  recipientLang: string;
  emotion: Exclude<Emotion, 'neutral'> | null;
  voiceId: string;
  queuedAt: string;
}

async function processAndInsertMessage(job: ProcessJob): Promise<void> {
  const {
    messageId,
    matchId,
    senderId,
    senderName,
    senderGender,
    recipientId,
    text,
    senderLang,
    recipientLang,
    emotion,
    voiceId,
    queuedAt,
  } = job;

  // 파이프라인 (voice clone 보유 발신자 전용 — voiceId 없는 경로는 route 안에서
  // 동기 INSERT 됨):
  //   1. Gemini 1회 호출 = STEP 1(실제 나타난 감정 마커 → [laughs]/[sad]) +
  //      STEP 2(번역). 출력은 sanitizeAudioTags 화이트리스트 검증됨.
  //   2. TTS — 태그 보존된 translation 으로 eleven_v3 합성.
  //   3. DB INSERT 시 translated_text 는 replaceTagsForDisplay 로 태그→슬랭 복원
  //      (UI 에 raw 태그 미노출). identity 면 null.
  //
  // 본 함수가 **마지막에 한 번만** INSERT 한다 — mid-session UPDATE 패턴 제거.
  try {
    // Gemini 가 STEP 1(감정 마커 → audio tag) + STEP 2(번역) 를 한 호출에서 처리.
    // translation 은 sanitizeAudioTags 로 화이트리스트 검증된 [laughs]/[sad] 포함.
    const { translation } = await translateMessage({
      text,
      targetLanguage: recipientLang,
    });
    // identity: 같은 언어이고 display(태그→슬랭 복원) 텍스트가 원문과 동일 →
    // 번역 인디케이터 숨김(translated_text=null). 코드스위칭(프로필=ko인데 영어로
    // 타이핑)이면 display 가 원문과 달라 not-identity → 번역 노출.
    const displayText = replaceTagsForDisplay(translation, recipientLang);
    const isIdentity =
      senderLang === recipientLang && displayText === text.trim();
    const translatedText = isIdentity ? null : displayText;

    // TTS 입력: [laughs] 만 남기고 [sad] 등 display-only 태그 제거 (사용자 정책).
    // 순수 sad 메시지(ㅠㅠ)는 strip 후 빈 텍스트 → TTS 스킵(audio_url=null),
    // display 슬랭은 translatedText 에 그대로 유지.
    const ttsText = stripNonAudibleTags(translation);

    let audioUrl: string | null = null;
    if (!hasSpeakableContent(ttsText)) {
      // TTS 스킵 — audio_url=null 이지만 의도된 경로이므로 'ready' 로 마킹.
    } else {
      const textToSynthesize = ensureSpeakableForTTS(ttsText);
      const audio = await synthesizeSpeech(textToSynthesize, voiceId, emotion, senderGender, recipientLang);
      const path = `${messageId}.mp3`;
      audioUrl = await uploadFile('voice-messages', path, audio, 'audio/mpeg');
    }

    // idempotent-send: 최종 INSERT 를 ON CONFLICT (id) DO NOTHING 으로.
    // 크로스-인스턴스 동시 재시도가 같은 id 로 도착해도 두 번째 파이프라인은
    // 0 rows (inserted=false) → row/푸시 단일. inserted=false 인데 row!=null 은
    // 다른 파이프라인이 이미 INSERT 한 케이스라 push 를 보내지 않는다.
    const { row, inserted, conflict } = await idempotentInsertMessage(
      {
        id: messageId,
        match_id: matchId,
        sender_id: senderId,
        original_text: text,
        original_language: senderLang,
        translated_text: translatedText,
        translated_language: recipientLang,
        audio_url: audioUrl,
        audio_status: 'ready',
        emotion,
        created_at: queuedAt,
      },
      matchId,
      senderId,
    );

    if (!row && !conflict) {
      // upsert/재select supabase 에러 — 헬퍼가 이미 console.error 로 가시화.
      return;
    }

    // push-notifications sprint: 'ready' INSERT 성공 직후 푸시 발송.
    // voice-first-message-gate 정책상 'ready' 메시지만 수신자에게 노출되므로
    // 'failed' 분기에서는 푸시 미발송 (거짓 신호 차단).
    // idempotent-send: 이번 호출이 실제로 INSERT 한 경우(inserted===true)에만
    // 발송 — 동시 재시도의 이중 푸시 방지.
    if (inserted) {
      sendPushToUser(recipientId, {
        type: 'message',
        match_id: matchId,
        sender_id: senderId,
        sender_name: senderName,
      }).catch((err) => console.error('[sendPushToUser message]', err));
    }
  } catch (error) {
    console.error(`[processAndInsertMessage] pipeline error messageId=${messageId}:`, error);
    console.dir(error, { depth: null });
    // 곱게 catch 한 외부 의존성(번역/TTS/Storage) 실패는 Sentry 자동수집 대상이
    // 아니므로 명시 보고 — 전체 장애(예: googleapis egress 차단) 를 첫 건에 감지.
    Sentry.captureException(error, {
      tags: { pipeline: 'message', stage: 'translate_tts' },
      extra: { messageId, matchId, senderLang, recipientLang },
    });
    // 파이프라인 실패 → 텍스트만 전송 (audio_url=null, audio_status='failed').
    // 송신자는 본인 메시지가 'failed' 인디케이터로 뜨고, 같은 텍스트를 다시
    // 입력해 재송신할 수 있다. mid-session UPDATE 가 없으므로 expo-audio
    // resource 회수 트리거도 발생 안 함.
    //
    // idempotent-send: 실패 INSERT 도 ON CONFLICT (id) DO NOTHING. 크로스-인스턴스
    // 경쟁으로 이미 'ready' 로 들어간 row 를 'failed' 로 덮어쓰지 않도록 —
    // DO NOTHING 이 정확히 이 보호를 한다 (23505 발생 없이 무시).
    const { error: insertError } = await supabase
      .from('messages')
      .upsert(
        {
          id: messageId,
          match_id: matchId,
          sender_id: senderId,
          original_text: text,
          original_language: senderLang,
          translated_text: null,
          translated_language: recipientLang,
          audio_url: null,
          audio_status: 'failed',
          emotion,
          created_at: queuedAt,
        },
        { onConflict: 'id', ignoreDuplicates: true },
      )
      .select();
    if (insertError) {
      console.error(`[processAndInsertMessage] failed-state insert error messageId=${messageId}:`, insertError.message);
    }
  } finally {
    // idempotent-send: try/catch 어느 경로로 끝나든 in-flight 가드 해제.
    endProcessing(messageId);
  }
}

export default router;
