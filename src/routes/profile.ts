import { Router, Response } from 'express';
import multer from 'multer';
import { supabase } from '../config/supabase';
import { uploadFile, deleteFile, extractPath } from '../services/storage';
import { generateVoiceIntroAudios, normalizeAuthorLanguage } from '../services/voiceIntro';
import { convertProfilePhoto } from '../services/photoConversion';
import { addWatermark } from '../services/photoWatermark';
import { authMiddleware } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { profileUpsertSchema, photoOrderSchema } from '../schemas/profile';
import { lookupBioPhrase } from '../constants/bioPhrasesCatalog';
import { requireNotFrozen } from '../utils/freezeGuard';
import { isBlocked } from '../constants/moderationDictionary';
import { checkOpenAiModeration } from '../services/openaiModeration';
import { logModerationBlock } from '../utils/moderationAudit';
import { AuthRequest, VoiceIntroTranslations } from '../types';

// photo-watercolor-pipeline sprint: 사진 최대 5장 (slot 0~4).
// 기존 라우트가 6장까지 허용하던 drift 를 본 sprint 에서 5장으로 정정.
const MAX_PHOTOS = 5;

const router = Router();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

router.use(authMiddleware);

type PhotoRow = {
  id: string;
  position: number;
  status: string;
  failure_reason: string | null;
  converted_url: string | null;
};

type PhotoStatusDto = {
  id: string;
  position: number;
  status: string;
  failure_reason: string | null;
};

function toPhotoStatusDto(r: PhotoRow): PhotoStatusDto {
  return {
    id: r.id,
    position: r.position,
    status: r.status,
    failure_reason: r.failure_reason,
  };
}

// 사진 변경(삭제/재배치) 후 즉시 sync 응답 조립용 공통 스냅샷 로더.
// DELETE /photos/:index 와 PATCH /photos/order 가 동일 응답 shape
// ({photo_statuses, photos}) 를 반환하므로 drift 방지를 위해 추출
// (evidence-hold-on-delete sprint 의 sweepAuditTable 헬퍼 추출 패턴).
async function loadPhotoSnapshot(
  userId: string,
): Promise<{ photo_statuses: PhotoStatusDto[]; photos: string[] }> {
  const { data: rows } = await supabase
    .from('profile_photos')
    .select('id, position, status, failure_reason, converted_url')
    .eq('user_id', userId)
    .order('position', { ascending: true });

  const list = (rows ?? []) as PhotoRow[];

  return {
    photo_statuses: list.map(toPhotoStatusDto),
    photos: list
      .filter((r) => r.status === 'ready' && r.converted_url)
      .map((r) => r.converted_url as string),
  };
}

// 내 프로필 조회
//
// photo-watercolor-pipeline sprint: 응답에 photo_statuses 배열 추가.
// FE 가 setup/step5 / settings/profile 화면에서 사진별 변환 status (processing /
// failed / rejected / ready) 를 폴링하여 인디케이터/재시도 UX 분기.
//
// 호환성 유지: photos 배열 (Profile.photos) 은 status='ready' 인 converted_url
// 만 position ASC 순으로 노출. 변환 미완료 사진은 photos 배열에 미포함 → 디스커버
// 노출 조건 (photos.length > 0) 자연 정합.
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

  // profile_photos 조회. mig 028 미적용 환경 가드 — error 가시화 + 빈 배열 폴백.
  const photoStatusesResult = await supabase
    .from('profile_photos')
    .select('id, position, status, failure_reason, converted_url')
    .eq('user_id', req.userId!)
    .order('position', { ascending: true });

  let photoStatuses: PhotoStatusDto[] = [];
  let readyPhotos: string[] = [];

  if (photoStatusesResult.error) {
    console.error('[profile.me.photo_statuses_select_failed]', photoStatusesResult.error.message);
  } else {
    const rows = (photoStatusesResult.data ?? []) as PhotoRow[];
    photoStatuses = rows.map(toPhotoStatusDto);
    readyPhotos = rows
      .filter((r) => r.status === 'ready' && r.converted_url)
      .map((r) => r.converted_url as string);
  }

  // mig 034: profiles.photos 컬럼 폐지. photos 응답은 profile_photos 의 ready
  // converted_url 만 사용. 행이 없으면 빈 배열 (회원가입 직후 / 변환 대기).
  const responsePhotos = readyPhotos;

  res.json({ ...data, photos: responsePhotos, photo_statuses: photoStatuses });
});

// 내 프로필 수정 (생성 포함 - upsert)
// message-moderation-v1 (PR2): freeze 사용자 mutating 차단.
router.put('/me', requireNotFrozen, validateBody(profileUpsertSchema), async (req: AuthRequest, res: Response) => {
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

  // voice-intro-moderation-unification sprint: voice intro 변경 시 메시지와 동일한
  // 모더레이션 게이트 (사전 키워드 차단 + OpenAI Moderation 2차 검수) 적용. 차별점
  // 2 (송신자 클론 보이스 TTS) 의 평판 리스크 표면 (디스커버 노출 + 클론 보이스 합성)
  // 을 메시지와 동일 인프라로 차단.
  //
  // 적용 조건: voiceIntroChanged === true 이고 resolvedVoiceIntro 가 비어있지 않으며
  // preset 매칭이 아닌 경우. preset 경로 (voice-intro-preset-bypass sprint) 는 BE
  // 카탈로그가 손번역 화이트리스트 + server-authoritative override 가 phrase_id 위조를
  // 차단하므로 모더레이션 우회 안전. 카탈로그 변경 게이트 (`bioPhrasesCatalog.test.ts`
  // EXPECTED_FE_FIXTURE drift 1차 방어선) 가 손번역의 안전성을 보장.
  //
  // 응답 shape (422 + code='message_blocked') 는 메시지와 의도적으로 동일 — FE
  // 422 핸들러 + i18n 토스트 키 재사용.
  if (voiceIntroChanged && resolvedVoiceIntro && !presetTranslations) {
    const dictResult = isBlocked(resolvedVoiceIntro);
    if (dictResult.blocked) {
      logModerationBlock({
        senderId: req.userId!,
        category: dictResult.category!,
        language: dictResult.language!,
        layer: 'dictionary',
        surface: 'voice_intro',
      });
      res.status(422).json({
        error: 'Voice intro contains restricted expressions',
        code: 'message_blocked',
      });
      return;
    }

    const openaiResult = await checkOpenAiModeration(resolvedVoiceIntro);
    if (openaiResult.blocked) {
      // OpenAI 는 multi-lingual 모델 — language 단정 어려움. 작성자 declared
      // language (normalizeAuthorLanguage 적용 전 raw 값) 를 fallback.
      const authorLang = (language as string | null | undefined) ?? 'ko';
      logModerationBlock({
        senderId: req.userId!,
        category: openaiResult.category!,
        language: authorLang,
        layer: 'openai',
        surface: 'voice_intro',
        rawCategory: openaiResult.rawCategory,
      });
      res.status(422).json({
        error: 'Voice intro contains restricted expressions',
        code: 'message_blocked',
      });
      return;
    }
  }

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

  // GET /me 와 동일한 shape 로 응답해야 한다 — photos 는 profile_photos 의 ready
  // converted_url, photo_statuses 도 동봉. 옛 코드는 raw `data` 만 반환해 FE 가
  // setProfile(updated) 로 store 를 덮어쓸 때 photos 가 레거시 profiles.photos
  // (mig 028 이후 비어있음) + photo_statuses=undefined 로 바뀌어, 프로필 탭의
  // 사진이 전부 사라지던 회귀를 유발했다 (앱 재시작 시 GET /me 폴백으로만 복구).
  // mig 034: profiles.photos 컬럼 폐지. photos 는 profile_photos snapshot 만 사용.
  const snapshot = await loadPhotoSnapshot(req.userId!);
  res.json({ ...data, photos: snapshot.photos, photo_statuses: snapshot.photo_statuses });
});

// 프로필 사진 재배치 (photo-reorder-no-reconvert sprint).
//
// 재변환 없이 profile_photos.position 만 원자적으로 재배치한다. order = 본인 소유
// 사진 id 의 배열, 배열 인덱스가 곧 새 position (order[0] → position 0 = 메인).
// 메인설정 = "특정 사진을 맨 앞으로", 순서변경 = "전체 순서 명시" — 둘 다 같은 연산.
//
// 동적 세그먼트(/photos/:index 등)보다 위에 등록해 매칭 충돌 회피 (PATCH 메서드라
// GET/POST/DELETE 와 어차피 안 겹치지만 안전 차원).
//
// message-moderation-v1 (PR2): freeze 사용자 mutating 차단.
router.patch(
  '/photos/order',
  requireNotFrozen,
  validateBody(photoOrderSchema),
  async (req: AuthRequest, res: Response) => {
    const order = req.body.order as string[];

    // mig 030 미적용 시 RPC not found → error 가시화 (silent-degrade 금지).
    const { error } = await supabase.rpc('reorder_profile_photos', {
      p_user_id: req.userId!,
      p_order: order,
    });

    if (error) {
      const msg = error.message || '';
      if (msg.includes('main_photo_not_ready')) {
        res.status(422).json({
          error: 'Main photo must be a ready (converted) photo',
          code: 'main_photo_not_ready',
        });
        return;
      }
      if (msg.includes('photo_not_owned')) {
        res.status(404).json({ error: 'Photo not found' });
        return;
      }
      if (msg.includes('order_count_mismatch')) {
        res.status(400).json({ error: 'order must include every photo' });
        return;
      }
      console.error('[profile.photos.reorder_rpc_failed]', msg);
      res.status(500).json({ error: msg });
      return;
    }

    // 성공 시 새 position 기준 스냅샷 즉시 반환 (FE 폴링 없이 sync).
    res.json(await loadPhotoSnapshot(req.userId!));
  },
);

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// 프로필 사진 업로드 (photo-watercolor-pipeline sprint — 비동기 변환).
//
// 흐름:
//   1) multer 가 받은 raw bytes 검증 + Storage `photos/{userId}/originals/{ts}_{uuid}.{ext}` 업로드.
//   2) profile_photos INSERT — position = 다음 빈 자리, status='processing'.
//   3) 비동기 convertProfilePhoto fire-and-forget 트리거.
//   4) 202 응답 — { photo_id, position, status: 'processing' }. FE 는 GET /me 폴링으로
//      ready 전이 감지.
//
// 모더레이션 거부 (status='rejected') 는 비동기 분기 — FE 폴링이 감지 후 토스트.
// 동기 422 거부는 본 sprint 범위 외 (raw bytes 단계의 pre-check 는 비용 cap 후속).
//
// message-moderation-v1 (PR2): freeze 사용자 mutating 차단.
router.post('/photos', requireNotFrozen, upload.single('photo'), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No photo file provided' });
    return;
  }

  if (!ALLOWED_IMAGE_TYPES.includes(req.file.mimetype)) {
    res.status(400).json({ error: 'Only JPEG, PNG, WebP images are allowed' });
    return;
  }

  // 현재 사진 개수 — profile_photos 테이블 기준 (5장 cap). mig 034 로 profiles.photos
  // 컬럼이 폐지돼 옛 배열 폴백은 제거. 조회 실패 시 500 가시화 (silent-success 금지).
  const photosCountResult = await supabase
    .from('profile_photos')
    .select('id, position', { count: 'exact' })
    .eq('user_id', req.userId!);

  if (photosCountResult.error) {
    console.error('[profile.photos.count_select_failed]', photosCountResult.error.message);
    res.status(500).json({ error: photosCountResult.error.message });
    return;
  }

  const usedPositions = new Set<number>();
  const rows = (photosCountResult.data ?? []) as Array<{ id: string; position: number }>;
  const currentCount = rows.length;
  rows.forEach((r) => usedPositions.add(r.position));

  if (currentCount >= MAX_PHOTOS) {
    res.status(400).json({ error: `Maximum ${MAX_PHOTOS} photos allowed` });
    return;
  }

  // 다음 빈 position — 0~4 중 첫 빈 자리.
  let nextPosition = 0;
  for (let i = 0; i < MAX_PHOTOS; i++) {
    if (!usedPositions.has(i)) {
      nextPosition = i;
      break;
    }
  }

  const ext = req.file.originalname.split('.').pop()?.toLowerCase() || 'jpg';
  const path = `${req.userId!}/originals/${Date.now()}_${crypto.randomUUID()}.${ext}`;

  let originalUrl: string;
  try {
    originalUrl = await uploadFile('photos', path, req.file.buffer, req.file.mimetype);
  } catch (err) {
    console.error('[profile.photos.upload_failed]', (err as Error).message);
    res.status(500).json({ error: 'Storage upload failed' });
    return;
  }

  // profile_photos INSERT — status='processing'. UNIQUE (user_id, position) 위반 시
  // race 가능성 → 23505 핸들링.
  const { data: insertResult, error: insertErr } = await supabase
    .from('profile_photos')
    .insert({
      user_id: req.userId!,
      position: nextPosition,
      original_path: path,
      status: 'processing',
    })
    .select('id, position')
    .single();

  if (insertErr) {
    console.error('[profile.photos.insert_failed]', insertErr.message);
    // 업로드된 원본 cleanup (fire-and-forget).
    deleteFile('photos', path).catch((e) =>
      console.error('[profile.photos.cleanup_after_insert_failed]', (e as Error).message),
    );
    res.status(500).json({ error: insertErr.message });
    return;
  }

  // 비동기 변환 트리거. fire-and-forget — error 가시화 명시.
  convertProfilePhoto({
    userId: req.userId!,
    photoRowId: insertResult.id,
    originalBuffer: req.file.buffer,
    mimeType: req.file.mimetype,
    originalPath: path,
  }).catch((err) => console.error('[profile.photos.convert_async_error]', (err as Error).message));

  // 호환성: 옛 wire shape ({ url, photos }) 도 응답에 동봉. FE 신규 클라이언트는
  // photo_id / position / status 사용, 옛 클라이언트는 url / photos 폴백.
  // status='processing' 이라 url 은 임시로 originalUrl 노출 — 변환 완료 후 폴링이
  // converted_url 로 갱신.
  res.status(202).json({
    photo_id: insertResult.id,
    position: insertResult.position,
    status: 'processing',
    // 옛 wire 호환 (변환 완료 전 임시 URL — FE 가 폴링 후 갱신).
    url: originalUrl,
    photos: undefined,
  });
});

// 프로필 사진 retry 라우트 (photo-watercolor-pipeline sprint).
//
// failed 사진만 수동 재시도 허용. rejected 는 422 (모더레이션 사유라 재시도 의미 없음 —
// 사용자가 다른 사진 업로드해야 함).
router.post('/photos/:photoId/retry', requireNotFrozen, async (req: AuthRequest, res: Response) => {
  const photoId = req.params.photoId as string;

  const { data: row, error: rowErr } = await supabase
    .from('profile_photos')
    .select('id, user_id, status, original_path, retry_count')
    .eq('id', photoId)
    .eq('user_id', req.userId!)
    .maybeSingle();

  if (rowErr) {
    res.status(500).json({ error: rowErr.message });
    return;
  }
  if (!row) {
    res.status(404).json({ error: 'Photo not found' });
    return;
  }
  if (row.status === 'rejected') {
    res.status(422).json({
      error: 'Photo was rejected by moderation. Please upload a different photo.',
      code: 'photo_blocked',
    });
    return;
  }
  if (row.status !== 'failed') {
    res.status(409).json({ error: `Cannot retry photo in status=${row.status}` });
    return;
  }
  if (!row.original_path) {
    res.status(409).json({ error: 'Original photo data is no longer available' });
    return;
  }

  // status='processing' 으로 전이 후 비동기 retry 트리거.
  const { error: updateErr } = await supabase
    .from('profile_photos')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', photoId);
  if (updateErr) {
    res.status(500).json({ error: updateErr.message });
    return;
  }

  // dynamic import 회피 — 순환 의존성 없음 (jobs 가 services 만 import).
  import('../services/photoConversion').then(({ retryPendingOrFailedPhoto }) => {
    retryPendingOrFailedPhoto(req.userId!, photoId, row.original_path as string).catch((e) =>
      console.error('[profile.photos.retry_async_error]', (e as Error).message),
    );
  }).catch((e) => console.error('[profile.photos.retry_import_error]', (e as Error).message));

  res.status(202).json({
    photo_id: photoId,
    status: 'processing',
  });
});

// 프로필 사진 워터마크 다운로드 (사진 저장용).
//
// 본인 사진(profile_photos.user_id == viewer)의 ready 변환본에 우하단 "haru"
// 텍스트 워터마크를 합성해 image/jpeg 로 반환한다. 원본/Storage 는 무변경 —
// 응답용 사본만 매 요청 생성 (다운로드 버튼 탭 시점에만 도는 cold path).
// position 기반 (DELETE 라우트와 동일 소유권 검증 패턴).
router.get('/photos/:position/download', async (req: AuthRequest, res: Response) => {
  const position = parseInt(req.params.position as string, 10);
  if (!Number.isFinite(position) || position < 0) {
    res.status(400).json({ error: 'Invalid photo position' });
    return;
  }

  const { data: row, error: rowErr } = await supabase
    .from('profile_photos')
    .select('converted_url, status')
    .eq('user_id', req.userId!)
    .eq('position', position)
    .maybeSingle();

  if (rowErr) {
    console.error('[profile.photos.download_select_failed]', rowErr.message);
    res.status(500).json({ error: rowErr.message });
    return;
  }
  if (!row) {
    res.status(404).json({ error: 'Photo not found' });
    return;
  }
  if (row.status !== 'ready' || !row.converted_url) {
    res.status(409).json({ error: `Photo is not ready (status=${row.status})` });
    return;
  }

  // converted_url 은 public URL — fetch 로 bytes 획득.
  let imageBytes: Buffer;
  try {
    const upstream = await fetch(row.converted_url as string);
    if (!upstream.ok) {
      throw new Error(`HTTP ${upstream.status}`);
    }
    imageBytes = Buffer.from(await upstream.arrayBuffer());
  } catch (err) {
    console.error('[profile.photos.download_fetch_failed]', (err as Error).message);
    res.status(502).json({ error: 'Failed to fetch source image' });
    return;
  }

  let watermarked: Buffer;
  try {
    watermarked = await addWatermark(imageBytes);
  } catch (err) {
    console.error('[profile.photos.watermark_failed]', (err as Error).message);
    res.status(500).json({ error: 'Failed to render watermark' });
    return;
  }

  res.set('Content-Type', 'image/jpeg');
  res.set('Content-Disposition', `attachment; filename="haru-photo-${position}.jpg"`);
  res.send(watermarked);
});

// 프로필 사진 삭제 (photo-watercolor-pipeline sprint — profile_photos row 삭제).
//
// index = profile_photos.position 으로 해석. row DELETE + Storage cleanup
// (converted_url + original_path 둘 다 시도).
//
// 호환성: mig 028 미적용 또는 백필 미실행 환경에선 옛 photos 배열 인덱스 폴백.
//
// message-moderation-v1 (PR2): freeze 사용자 mutating 차단.
router.delete('/photos/:index', requireNotFrozen, async (req: AuthRequest, res: Response) => {
  const index = parseInt(req.params.index as string, 10);
  if (!Number.isFinite(index) || index < 0) {
    res.status(400).json({ error: 'Invalid photo index' });
    return;
  }

  // profile_photos row 조회 — position=index.
  const { data: row, error: rowErr } = await supabase
    .from('profile_photos')
    .select('id, converted_url, original_path')
    .eq('user_id', req.userId!)
    .eq('position', index)
    .maybeSingle();

  if (rowErr) {
    console.error('[profile.photos.delete_select_failed]', rowErr.message);
    res.status(500).json({ error: rowErr.message });
    return;
  }

  if (!row) {
    res.status(400).json({ error: 'Invalid photo index' });
    return;
  }

  // DB 먼저 DELETE (Storage 고아 파일보다 DB 불일치가 더 위험 — 기존 정책).
  const { error: deleteErr } = await supabase
    .from('profile_photos')
    .delete()
    .eq('id', row.id);

  if (deleteErr) {
    console.error('[profile.photos.delete_failed]', deleteErr.message);
    res.status(500).json({ error: deleteErr.message });
    return;
  }

  // Storage cleanup (fire-and-forget — converted_url + original_path 둘 다).
  if (row.converted_url) {
    try {
      const convertedPath = extractPath('photos', row.converted_url as string);
      deleteFile('photos', convertedPath).catch((e) =>
        console.error('[profile.photos.delete_converted_cleanup_failed]', (e as Error).message),
      );
    } catch (e) {
      console.warn('[profile.photos.extract_converted_path_failed]', (e as Error).message);
    }
  }
  if (row.original_path) {
    const op = row.original_path as string;
    // 백필 URL (http) 인 경우 path 추출 시도.
    let pathToDelete: string | null = null;
    if (op.startsWith('http://') || op.startsWith('https://')) {
      try {
        pathToDelete = extractPath('photos', op);
      } catch {
        pathToDelete = null;
      }
    } else {
      pathToDelete = op;
    }
    if (pathToDelete) {
      deleteFile('photos', pathToDelete).catch((e) =>
        console.error('[profile.photos.delete_original_cleanup_failed]', (e as Error).message),
      );
    }
  }

  // 삭제 후 position 압축 — 지운 자리(index) 뒤의 사진들을 한 칸씩 앞으로 당긴다.
  // ascending 순서로 한 row 씩 position-1 로 UPDATE: 지운 자리가 비어 있고 각 row 가
  // 직전에 비워진 슬롯으로 내려가므로 UNIQUE(user_id, position) 충돌이 없다. gap 을
  // 남기면 (a) 그리드 중간에 빈 칸 (b) 메인(position 0) 삭제 시 다음 사진이 0 으로
  // 안 올라와 디스커버 노출 누락. 변환 중 row 도 합성은 id 기준 갱신이라 이동과 무관.
  //
  // ?compact=false: "변경(replace)" 흐름이 사용 — gap 을 그 자리에 남겨 직후
  // 업로드(POST /photos)가 "첫 빈 자리"=원래 슬롯을 채우게 한다(순서 유지). 단독
  // 삭제는 기본(압축).
  const skipCompact = req.query.compact === 'false';
  if (!skipCompact) {
    const { data: toShift, error: shiftSelErr } = await supabase
      .from('profile_photos')
      .select('id, position')
      .eq('user_id', req.userId!)
      .gt('position', index)
      .order('position', { ascending: true });

    if (shiftSelErr) {
      console.error('[profile.photos.delete_compact_select_failed]', shiftSelErr.message);
    } else {
      for (const r of (toShift ?? []) as Array<{ id: string; position: number }>) {
        const { error: shiftErr } = await supabase
          .from('profile_photos')
          .update({ position: r.position - 1 })
          .eq('id', r.id);
        if (shiftErr) {
          console.error('[profile.photos.delete_compact_update_failed]', {
            photo_id: r.id,
            from: r.position,
            to: r.position - 1,
            error: shiftErr.message,
          });
          break; // 부분 압축은 다음 삭제/재배치가 복구 — 무한 진행 방지
        }
      }
    }
  }

  // 응답: 남은 photo_statuses 노출 (FE 가 polling 없이도 즉시 sync).
  res.json(await loadPhotoSnapshot(req.userId!));
});

export default router;
