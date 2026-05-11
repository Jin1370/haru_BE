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
import { AuthRequest, Emotion, MatchAfter } from '../types';

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

  let query = supabase
    .from('messages')
    .select('*')
    .eq('match_id', matchId)
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
router.post('/:matchId/messages', validateBody(sendMessageSchema), async (req: AuthRequest, res: Response) => {
  const { matchId } = req.params;
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

  // 차단 여부 확인
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
  const [senderResult, recipientResult] = await Promise.all([
    supabase.from('profiles').select('language, elevenlabs_voice_id').eq('id', req.userId!).single(),
    supabase.from('profiles').select('language').eq('id', recipientId).single(),
  ]);

  const sender = senderResult.data;
  const recipient = recipientResult.data;
  const senderLang = (sender?.language as string | null) ?? null;
  const recipientLang = (recipient?.language as string | null) ?? null;

  if (!sender || !recipient || !senderLang || !recipientLang) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  // 메시지 INSERT (텍스트 즉시 저장)
  const { data: message, error: insertError } = await supabase
    .from('messages')
    .insert({
      match_id: matchId,
      sender_id: req.userId!,
      original_text: text,
      original_language: senderLang,
      translated_language: recipientLang,
      emotion: storedEmotion,
      audio_status: sender.elevenlabs_voice_id ? 'processing' : 'pending',
    })
    .select()
    .single();

  if (insertError) {
    res.status(500).json({ error: insertError.message });
    return;
  }

  // mig 014c AFTER INSERT 트리거가 동기 실행되어 matches 행 갱신 후
  // 본 줄에 도달한다. 트리거 결과를 즉시 읽어 응답에 match_after 로 동봉
  // → FE useChat 이 roundTrips/photoUnlocked 를 send 응답 한 번에 시드.
  // 백필 실패 매치(round_trip_count=NULL)는 0/false 로 정규화.
  const { data: matchAfterRow } = await supabase
    .from('matches')
    .select('round_trip_count, main_photo_unlocked_at, all_photos_unlocked_at')
    .eq('id', matchId)
    .single();

  const matchAfter: MatchAfter = {
    round_trip_count:
      (matchAfterRow?.round_trip_count as number | null | undefined) ?? 0,
    main_photo_unlocked:
      (matchAfterRow?.main_photo_unlocked_at as string | null | undefined) != null,
    all_photos_unlocked:
      (matchAfterRow?.all_photos_unlocked_at as string | null | undefined) != null,
  };

  // 즉시 응답 반환 (텍스트 메시지는 바로 전달). 기존 message 필드는 그대로 두고
  // match_after nested 필드 1개만 추가 → 구버전 FE 는 미지 필드로 무시.
  res.status(201).json({ ...message, match_after: matchAfter });

  // 비동기로 번역 + TTS 처리
  if (sender.elevenlabs_voice_id) {
    processMessageAudio(
      message.id,
      text,
      sender.elevenlabs_voice_id,
      senderLang,
      recipientLang,
      storedEmotion
    ).catch((err) => console.error('[processMessageAudio unhandled]', err));
  }
});

// 메시지 읽음 처리
router.patch('/:matchId/messages/read', async (req: AuthRequest, res: Response) => {
  const { matchId } = req.params;

  // 매치 참여자 확인
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

  // 상대가 보낸 읽지 않은 메시지를 일괄 업데이트
  const { count, error } = await supabase
    .from('messages')
    .update({ read_at: new Date().toISOString() }, { count: 'exact' })
    .eq('match_id', matchId)
    .neq('sender_id', req.userId!)
    .is('read_at', null);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ read_count: count || 0 });
});

// 실패한 오디오 재생성
router.post('/:messageId/retry', async (req: AuthRequest, res: Response) => {
  const { messageId } = req.params;

  const { data: message } = await supabase
    .from('messages')
    .select('*, match:matches(*)')
    .eq('id', messageId)
    .eq('sender_id', req.userId!)
    .single();

  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  if (message.audio_status !== 'failed') {
    res.status(400).json({ error: 'Audio is not in failed state' });
    return;
  }

  const { data: sender } = await supabase
    .from('profiles')
    .select('elevenlabs_voice_id, language')
    .eq('id', req.userId!)
    .single();

  if (!sender?.elevenlabs_voice_id) {
    res.status(400).json({ error: 'No voice clone available' });
    return;
  }

  await supabase.from('messages').update({ audio_status: 'processing' }).eq('id', messageId);

  res.json({ status: 'processing' });

  processMessageAudio(
    messageId as string,
    message.original_text,
    sender.elevenlabs_voice_id,
    message.original_language,
    message.translated_language,
    message.emotion ?? null
  ).catch((err) => console.error('[processMessageAudio unhandled]', err));
});

async function processMessageAudio(
  messageId: string,
  text: string,
  voiceId: string,
  sourceLanguage: string,
  targetLanguage: string,
  emotion: Exclude<Emotion, 'neutral'> | null
): Promise<void> {
  try {
    // 파이프라인:
    //   1. prepareTextForTTS — 감정 마커(ㅋㅋ/ㅠㅠ/에휴 등) 를 eleven_v3 audio tag 로 치환.
    //      Gemini 가 마커를 "탄식"으로 오번역하거나 TTS 가 마커 글자를 직접 발화하는
    //      두 가지 사고를 한 번에 차단. 정규화(length-cap) 는 이 단계로 흡수됨.
    //   2. Gemini 번역 — 시스템 프롬프트의 audio tag 보존 룰이 태그를 그대로 통과시킴.
    //      매치 단계에서 동일 대표언어 후보는 하드 제외이지만 대화 중 언어 전환·cross-script
    //      입력 가능성 때문에 source==target 여부와 무관하게 항상 Gemini 경유.
    //   3. TTS — 태그 보존된 텍스트로 eleven_v3 합성. 태그는 효과음, 나머지는 발화.
    //   4. DB 저장 시 translated_text 는 stripAudioTags 로 태그 제거 (UI 노출 방지).
    const taggedSource = prepareTextForTTS(text);

    const { translation } = await translateMessage({
      text: taggedSource,
      targetLanguage,
    });
    // Identity 조건: 동일 언어 페어에서 Gemini 가 변형 없이 반환한 케이스만.
    // cross-language(source!=target) 라면 Gemini 가 태그를 보존했더라도 슬랭 표기는
    // 타깃 언어로 바꿔서 보여줘야 함 (예: [laughs] → ja=www, en=lol).
    const isIdentity =
      sourceLanguage === targetLanguage && translation === taggedSource;
    const translatedText = isIdentity
      ? null
      : replaceTagsForDisplay(translation, targetLanguage);

    // 발화 불가 메시지(`:)`/`<3`/`???`/이모지 단독 등) 는 TTS 호출을 스킵하고
    // audio_url=null 로 저장. FE 가 audio_url 없을 때 재생 버튼 숨김 → 무음 재생
    // 버튼이 표시되는 UX 사고 차단.
    if (!hasSpeakableContent(translation)) {
      console.log(
        `[processMessageAudio] messageId=${messageId} ${sourceLanguage}->${targetLanguage} skip TTS (no speakable content)`,
        { original: text, translated: translation },
      );
      await supabase
        .from('messages')
        .update({
          translated_text: translatedText,
          audio_url: null,
          audio_status: 'ready',
        })
        .eq('id', messageId);
      return;
    }

    // 사용자가 ㅋㅋㅋ/ㅠㅠ/에휴 등 감정 마커만 보내면 번역 결과가 audio tag 단독이 됨.
    // ElevenLabs 가 tag/이모지 strip 후 빈 텍스트면 reject 하므로 마침표로 패딩.
    const textToSynthesize = ensureSpeakableForTTS(translation);

    console.log(
      `[processMessageAudio] messageId=${messageId} ${sourceLanguage}->${targetLanguage}`,
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
    const audioUrl = await uploadFile('voice-messages', path, audio, 'audio/mpeg');

    await supabase
      .from('messages')
      .update({
        audio_url: audioUrl,
        translated_text: translatedText,
        audio_status: 'ready',
      })
      .eq('id', messageId);
  } catch (error) {
    console.error(`[processMessageAudio] messageId=${messageId}:`, error);
    console.dir(error, { depth: null });
    await supabase.from('messages').update({ audio_status: 'failed' }).eq('id', messageId);
  }
}

export default router;
