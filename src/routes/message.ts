import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { uploadFile } from '../services/storage';
import { synthesizeSpeech } from '../services/elevenlabs';
import { translateMessage } from '../services/translation';
import { authMiddleware } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { sendMessageSchema, messageQuerySchema } from '../schemas/message';
import { AuthRequest, Emotion } from '../types';

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

  // 즉시 응답 반환 (텍스트 메시지는 바로 전달)
  res.status(201).json(message);

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
    let textToSynthesize = text;
    let translatedText: string | null = null;

    if (sourceLanguage !== targetLanguage) {
      const { translation } = await translateMessage({
        text,
        sourceLanguage,
        targetLanguage,
      });
      textToSynthesize = translation;
      translatedText = translation;
    }

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
