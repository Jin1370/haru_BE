import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { uploadFile } from '../services/storage';
import { synthesizeSpeech } from '../services/elevenlabs';
import { translateMessage } from '../services/translation';
import {
  prepareTextForTTS,
  replaceTagsForDisplay,
  ensureSpeakableForTTS,
  hasSpeakableContent,
} from '../utils/textNormalization';
import { authMiddleware } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { sendMessageSchema, messageQuerySchema } from '../schemas/message';
import { AuthRequest, Emotion } from '../types';
import { sendPushToUser } from '../services/pushNotifications';
import { randomUUID } from 'crypto';

const router = Router();

router.use(authMiddleware);

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
router.post('/:matchId/messages', validateBody(sendMessageSchema), async (req: AuthRequest, res: Response) => {
  const matchId = req.params.matchId as string;
  const { text, emotion } = req.body as { text: string; emotion?: Emotion };
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
  const [senderResult, recipientResult] = await Promise.all([
    supabase.from('profiles').select('language, elevenlabs_voice_id, display_name').eq('id', req.userId!).single(),
    supabase.from('profiles').select('language').eq('id', recipientId).single(),
  ]);

  const sender = senderResult.data;
  const recipient = recipientResult.data;
  const senderLang = (sender?.language as string | null) ?? null;
  const recipientLang = (recipient?.language as string | null) ?? null;
  const senderName = (sender?.display_name as string | null) ?? '';

  if (!sender || !recipient || !senderLang || !recipientLang) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  // queueing 시점에 message id + created_at 을 미리 확정. created_at 을
  // 이 시점에 고정하는 이유는 비동기 TTS 가 메시지마다 다른 시간을 잡아
  // 늦게 보낸 메시지가 먼저 INSERT 되는 순서 역전을 막기 위함. INSERT 시
  // `created_at` 컬럼에 이 값을 명시 → ORDER BY created_at 이 send 순서.
  const messageId = randomUUID();
  const queuedAt = new Date().toISOString();
  const voiceId = sender.elevenlabs_voice_id ?? null;

  // voice clone 없는 발신자는 mid-session UPDATE 가 발생할 수 없는 경로
  // (audio_status 전이가 일어나지 않음). 동기 INSERT 후 응답 — UX 가 가장
  // 단순하고 회귀 위험 최소.
  if (!voiceId) {
    const { data: row, error: insertError } = await supabase
      .from('messages')
      .insert({
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
      })
      .select()
      .single();
    if (insertError) {
      res.status(500).json({ error: insertError.message });
      return;
    }
    res.status(201).json(row);

    // push-notifications sprint: 동기 INSERT 경로 (voice-clone 미보유 발신자) 의
    // 푸시 발송. INSERT 가 'pending' 상태로 저장되지만 voice-first-message-gate
    // 정책상 수신자 GET 에서 필터링되어 안 보이는 메시지 — 푸시도 보내지 않는다.
    // (failed 메시지와 같은 정합성: "수신자에게 안 보이는 메시지 = 푸시 미발송")
    // 사실상 voice clone 미보유 발신자의 메시지는 푸시 미발송 분기.
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

  processAndInsertMessage({
    messageId,
    matchId,
    senderId: req.userId!,
    senderName,
    recipientId,
    text,
    senderLang,
    recipientLang,
    emotion: storedEmotion,
    voiceId,
    queuedAt,
  }).catch((err) => console.error('[processAndInsertMessage unhandled]', err));
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

interface ProcessJob {
  messageId: string;
  matchId: string;
  senderId: string;
  senderName: string;
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
  //   1. prepareTextForTTS — 감정 마커(ㅋㅋ/ㅠㅠ/에휴 등) 를 eleven_v3 audio tag 로 치환.
  //   2. Gemini 번역 — 시스템 프롬프트의 audio tag 보존 룰이 태그를 그대로 통과시킴.
  //   3. TTS — 태그 보존된 텍스트로 eleven_v3 합성.
  //   4. DB INSERT 시 translated_text 는 stripAudioTags 로 태그 제거 (UI 노출 방지).
  //
  // 본 함수가 **마지막에 한 번만** INSERT 한다 — mid-session UPDATE 패턴 제거.
  try {
    const taggedSource = prepareTextForTTS(text);

    const { translation } = await translateMessage({
      text: taggedSource,
      targetLanguage: recipientLang,
    });
    const isIdentity =
      senderLang === recipientLang && translation === taggedSource;
    const translatedText = isIdentity
      ? null
      : replaceTagsForDisplay(translation, recipientLang);

    let audioUrl: string | null = null;
    if (!hasSpeakableContent(translation)) {
      console.log(
        `[processAndInsertMessage] messageId=${messageId} ${senderLang}->${recipientLang} skip TTS (no speakable content)`,
        { original: text, translated: translation },
      );
      // TTS 스킵 — audio_url=null 이지만 의도된 경로이므로 'ready' 로 마킹.
    } else {
      const textToSynthesize = ensureSpeakableForTTS(translation);
      console.log(
        `[processAndInsertMessage] messageId=${messageId} ${senderLang}->${recipientLang}`,
        {
          original: text,
          tagged: taggedSource,
          translated: translation,
          translatedClean: translatedText,
          toTTS: textToSynthesize,
        },
      );
      const audio = await synthesizeSpeech(textToSynthesize, voiceId, emotion);
      const path = `${messageId}.mp3`;
      audioUrl = await uploadFile('voice-messages', path, audio, 'audio/mpeg');
    }

    const { error: insertError } = await supabase.from('messages').insert({
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
    });

    if (insertError) {
      console.error(`[processAndInsertMessage] insert failed messageId=${messageId}:`, insertError);
      return;
    }

    // push-notifications sprint: 'ready' INSERT 성공 직후 푸시 발송.
    // voice-first-message-gate 정책상 'ready' 메시지만 수신자에게 노출되므로
    // 'failed' 분기에서는 푸시 미발송 (거짓 신호 차단).
    sendPushToUser(recipientId, {
      type: 'message',
      match_id: matchId,
      sender_id: senderId,
      sender_name: senderName,
    }).catch((err) => console.error('[sendPushToUser message]', err));
  } catch (error) {
    console.error(`[processAndInsertMessage] pipeline error messageId=${messageId}:`, error);
    console.dir(error, { depth: null });
    // 파이프라인 실패 → 텍스트만 전송 (audio_url=null, audio_status='failed').
    // 송신자는 본인 메시지가 'failed' 인디케이터로 뜨고, 같은 텍스트를 다시
    // 입력해 재송신할 수 있다. mid-session UPDATE 가 없으므로 expo-audio
    // resource 회수 트리거도 발생 안 함.
    const { error: insertError } = await supabase.from('messages').insert({
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
    });
    if (insertError) {
      console.error(`[processAndInsertMessage] failed-state insert error messageId=${messageId}:`, insertError);
    }
  }
}

export default router;
