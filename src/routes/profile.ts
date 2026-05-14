import { Router, Response } from 'express';
import multer from 'multer';
import { supabase } from '../config/supabase';
import { uploadFile, deleteFile, extractPath } from '../services/storage';
import { generateVoiceIntroAudios, normalizeAuthorLanguage } from '../services/voiceIntro';
import { authMiddleware } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { profileUpsertSchema } from '../schemas/profile';
import { lookupBioPhrase } from '../constants/bioPhrasesCatalog';
import { AuthRequest, VoiceIntroTranslations } from '../types';

const router = Router();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

router.use(authMiddleware);

// 내 프로필 조회
router.get('/me', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.userId!)
    .single();

  if (error) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  res.json(data);
});

// 내 프로필 수정 (생성 포함 - upsert)
router.put('/me', validateBody(profileUpsertSchema), async (req: AuthRequest, res: Response) => {
  const {
    display_name,
    birth_date,
    gender,
    nationality,
    language,
    voice_intro,
    voice_intro_phrase_id,
    interests,
  } = req.body;

  // 기존 voice_intro를 조회해 변경 여부 판단. 바뀌지 않았으면 TTS 재생성을 건너뛰어
  // 불필요한 ElevenLabs 호출을 막는다.
  const { data: prev } = await supabase
    .from('profiles')
    .select('voice_intro')
    .eq('id', req.userId!)
    .maybeSingle();

  // voice-intro-preset-bypass sprint: phrase id 매칭 시 BE 카탈로그가
  // 작성자 언어/번역 텍스트의 단일 진실 소스. 사용자 페이로드의 voice_intro 와
  // 카탈로그 텍스트가 다를 경우(클라이언트 위조/구버전 OTA) 카탈로그가 우선.
  // 미상 id 는 폴백 — Gemini 경로로 흡수, 사용자에게 reject 노출하지 않음.
  let presetTranslations: VoiceIntroTranslations | undefined;
  let resolvedVoiceIntro: string | null = voice_intro ?? null;
  if (voice_intro_phrase_id) {
    const entry = lookupBioPhrase(voice_intro_phrase_id);
    if (entry) {
      presetTranslations = entry.text;
      // Server-authoritative override: voice_intro 컬럼도 카탈로그의 작성자 언어
      // 텍스트로 덮어쓴다. display 와 audio 의 텍스트 일관성 강제(시나리오 8 방어).
      const authorLang = normalizeAuthorLanguage(language);
      resolvedVoiceIntro = entry.text[authorLang];
    } else {
      console.warn(
        `[Voice intro preset bypass] unknown phrase_id=${voice_intro_phrase_id} userId=${req.userId} — falling back to Gemini`,
      );
    }
  }

  const prevVoiceIntro = prev?.voice_intro ?? null;
  const nextVoiceIntro = resolvedVoiceIntro;
  const voiceIntroChanged = prevVoiceIntro !== nextVoiceIntro;

  const upsertPayload: Record<string, unknown> = {
    id: req.userId!,
    display_name,
    birth_date,
    gender,
    nationality,
    language,
    voice_intro: resolvedVoiceIntro,
    interests: interests || [],
    updated_at: new Date().toISOString(),
  };
  // voice_intro 가 바뀌면 FE 폴링이 재합성 구간을 감지할 수 있도록 다국어 슬롯
  // 3컬럼을 빈 객체로 리셋한다. 신규 파이프라인이 비동기로 다시 채운다.
  if (voiceIntroChanged) {
    upsertPayload.voice_intro_translations = {};
    upsertPayload.voice_intro_audio_urls = {};
    upsertPayload.voice_intro_audio_status = {};
  }

  const { data, error } = await supabase
    .from('profiles')
    .upsert(upsertPayload)
    .select()
    .single();

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  // voice_intro 가 실제로 바뀐 경우에만 다국어 오디오 파이프라인 트리거.
  // voice_clone 미보유면 스킵 (FE 폴링이 단일 컬럼/status fallback 으로 처리).
  // preset 매칭 시 presetTranslations 주입 → service 가 Gemini 단계 스킵.
  if (voiceIntroChanged && resolvedVoiceIntro && data.elevenlabs_voice_id) {
    generateVoiceIntroAudios(
      req.userId!,
      resolvedVoiceIntro,
      data.elevenlabs_voice_id,
      language,
      presetTranslations,
      gender,
    ).catch((err) => console.error('[Voice intro audios generation failed]', err));
  }

  res.json(data);
});

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// 프로필 사진 업로드
router.post('/photos', upload.single('photo'), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No photo file provided' });
    return;
  }

  if (!ALLOWED_IMAGE_TYPES.includes(req.file.mimetype)) {
    res.status(400).json({ error: 'Only JPEG, PNG, WebP images are allowed' });
    return;
  }

  // 현재 사진 개수 확인
  const { data: profile } = await supabase
    .from('profiles')
    .select('photos')
    .eq('id', req.userId!)
    .single();

  const currentPhotos: string[] = profile?.photos || [];
  if (currentPhotos.length >= 6) {
    res.status(400).json({ error: 'Maximum 6 photos allowed' });
    return;
  }

  const ext = req.file.originalname.split('.').pop()?.toLowerCase() || 'jpg';
  const path = `${req.userId!}/${Date.now()}_${crypto.randomUUID()}.${ext}`;
  const url = await uploadFile('photos', path, req.file.buffer, req.file.mimetype);

  const updatedPhotos = [...currentPhotos, url];
  await supabase
    .from('profiles')
    .update({ photos: updatedPhotos, updated_at: new Date().toISOString() })
    .eq('id', req.userId!);

  res.json({ url, photos: updatedPhotos });
});

// 프로필 사진 삭제
router.delete('/photos/:index', async (req: AuthRequest, res: Response) => {
  const index = parseInt(req.params.index as string, 10);

  const { data: profile } = await supabase
    .from('profiles')
    .select('photos')
    .eq('id', req.userId!)
    .single();

  const currentPhotos: string[] = profile?.photos || [];
  if (index < 0 || index >= currentPhotos.length) {
    res.status(400).json({ error: 'Invalid photo index' });
    return;
  }

  const photoUrl = currentPhotos[index];
  const updatedPhotos = currentPhotos.filter((_, i) => i !== index);

  // DB 먼저 업데이트 (실패 시 Storage 고아 파일보다 DB 불일치가 더 위험)
  await supabase
    .from('profiles')
    .update({ photos: updatedPhotos, updated_at: new Date().toISOString() })
    .eq('id', req.userId!);

  const path = extractPath('photos', photoUrl);
  deleteFile('photos', path).catch((err) => console.error('[Photo delete from storage failed]', err));

  res.json({ photos: updatedPhotos });
});

export default router;
