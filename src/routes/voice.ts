import { Router, Response } from 'express';
import multer from 'multer';
import { supabase } from '../config/supabase';
import { uploadFile } from '../services/storage';
import { createVoiceClone, deleteVoiceClone } from '../services/elevenlabs';
import { authMiddleware } from '../middleware/auth';
import { requireNotFrozen } from '../utils/freezeGuard';
import { env } from '../config/env';
import { AuthRequest } from '../types';

const router = Router();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

router.use(authMiddleware);

const ALLOWED_AUDIO_TYPES = ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/ogg', 'audio/webm'];

// FE 우회 케이스 백스톱. FE 가드(useVoiceCloneRecorder.ts) 는
//   * 평균 dBFS ≥ -35 (MIN_AVG_METERING_DB)
//   * bitrate ≥ 7000 bytes/s × 10s = 70KB (MIN_BYTES_PER_SEC)
// 두 조건으로 정상 녹음만 통과시킨다. BE 는 디코더 없이 dB 를 다시
// 잴 수 없으므로, 보수적으로 40KB 미만(=정상 녹음의 절반 이하)을
// 무음/너무 짧은 케이스로 보고 차단한다. FE 임계 변경 시 본 상수도
// 같이 비례 조정 검토.
const MIN_VOICE_SAMPLE_BYTES = 40 * 1024;

// 재녹음 레이트리밋 상태 계산 (POST /clone 가드 + GET /status 노출 공유).
// 윈도우는 "첫 재녹음 시점(window_start) + recloneWindowDays" 고정 윈도우.
// window 만료/미시작이면 remaining=cap, resetAt=null (다음 재녹음에서 새 윈도우 시작).
function computeRecloneState(count: number, windowStartIso: string | null): {
  remaining: number; cap: number; resetAt: string | null; windowActive: boolean;
} {
  const cap = env.voice.recloneMonthlyCap;
  const windowMs = env.voice.recloneWindowDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const windowStartMs = windowStartIso ? new Date(windowStartIso).getTime() : null;
  const windowActive = windowStartMs != null && now - windowStartMs < windowMs;
  if (windowActive) {
    return {
      remaining: Math.max(0, cap - count),
      cap,
      resetAt: new Date(windowStartMs! + windowMs).toISOString(),
      windowActive: true,
    };
  }
  return { remaining: cap, cap, resetAt: null, windowActive: false };
}

// 음성 샘플 업로드 + ElevenLabs 클론 생성
// message-moderation-v1 (PR2): freeze 사용자의 voice clone 재생성 차단 — voice clone
// 자체가 자동 freeze 의 root cause (노골 표현 합성) 이므로 frozen 사용자가 자기
// voice 를 갱신해 우회하는 경로를 막는다.
router.post('/clone', requireNotFrozen, upload.single('audio'), async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No audio file provided' });
    return;
  }

  if (!ALLOWED_AUDIO_TYPES.includes(req.file.mimetype)) {
    res.status(400).json({ error: 'Only audio files (WAV, MP3, MP4, OGG, WebM) are allowed' });
    return;
  }

  if (req.file.size < MIN_VOICE_SAMPLE_BYTES) {
    res.status(400).json({ error: 'Voice sample is too quiet or too short. Please record again.' });
    return;
  }

  try {
    // 정책: voice-clone 보유자는 부분 삭제가 불가능하고 "재생성"만 가능. 즉
    // 본 라우트는 신규 등록 + 재등록(덮어쓰기) 두 경로를 모두 책임진다.
    // 기존 voice_id 가 있으면 새 clone 생성 성공 후 옛 voice 는 fire-and-forget
    // 으로 ElevenLabs 측 정리 — 새 clone 실패 시 옛것은 그대로 보존되어야 하므로
    // 옛 voice 삭제는 반드시 성공 이후로 미룬다.
    // 재녹음 카운터 컬럼(mig 032)까지 한 번에 조회. 컬럼이 아직 없으면(마이그
    // 미적용) voice_id 만 다시 읽어 cleanup 은 유지하고 재녹음 가드는 비활성으로
    // graceful degrade — 옛 voice cleanup 회귀를 막는다.
    let prevVoiceId: string | null = null;
    let recloneGuardActive = true;
    let prevRecloneCount = 0;
    let prevWindowStartIso: string | null = null;
    {
      const { data, error } = await supabase
        .from('profiles')
        .select('elevenlabs_voice_id, voice_reclone_count, voice_reclone_window_start')
        .eq('id', req.userId!)
        .single();
      if (error) {
        console.warn('[voice.clone.reclone_columns_missing]', error.message);
        recloneGuardActive = false;
        const { data: vidOnly } = await supabase
          .from('profiles')
          .select('elevenlabs_voice_id')
          .eq('id', req.userId!)
          .single();
        prevVoiceId = (vidOnly?.elevenlabs_voice_id as string | null) ?? null;
      } else {
        prevVoiceId = (data?.elevenlabs_voice_id as string | null) ?? null;
        prevRecloneCount = (data?.voice_reclone_count as number | null) ?? 0;
        prevWindowStartIso = (data?.voice_reclone_window_start as string | null) ?? null;
      }
    }

    // 재녹음(=기존 voice_id 보유 상태에서의 재등록)만 레이트리밋. 최초 등록은
    // 카운트/차단 제외. 고정 윈도우(recloneWindowDays) 동안 recloneMonthlyCap 초과
    // 시 429 — ElevenLabs 월간 voice operations 풀을 1인 어뷰즈로부터 보호.
    const isReRecord = prevVoiceId != null;
    let nextRecloneCount = prevRecloneCount;
    let nextWindowStartIso = prevWindowStartIso;
    if (isReRecord && recloneGuardActive) {
      const state = computeRecloneState(prevRecloneCount, prevWindowStartIso);

      if (state.remaining <= 0) {
        res.status(429).json({
          error: 'Re-record limit reached for this period',
          code: 'reclone_limit',
          retry_after: state.resetAt,
        });
        return;
      }

      if (state.windowActive) {
        nextRecloneCount = prevRecloneCount + 1;
        nextWindowStartIso = prevWindowStartIso;
      } else {
        // 윈도우 만료 또는 첫 재녹음 → 새 윈도우 시작.
        nextRecloneCount = 1;
        nextWindowStartIso = new Date(Date.now()).toISOString();
      }
    }

    // silent-success 룰 (CLAUDE.md): UPDATE error 가시화. processing 마킹
    // 실패해도 ElevenLabs 호출은 진행할 수 있어 응답 자체 막진 않으나, 운영
    // 모니터링용 로그는 남긴다.
    const { error: processingErr } = await supabase
      .from('profiles')
      .update({ voice_clone_status: 'processing' })
      .eq('id', req.userId!);
    if (processingErr) {
      console.error('[voice.clone.processing_update_failed]', processingErr.message);
    }

    // ElevenLabs 클론 생성
    const voiceId = await createVoiceClone(req.userId!, req.file.buffer, req.file.originalname);

    // 프로필 업데이트 (새 voice_id 로 덮어쓰기). 본 UPDATE 실패는 critical —
    // ElevenLabs 측에는 새 clone 이 만들어졌는데 profile.voice_id 가 옛 값으로 남으면
    // 사용자가 응답에서 받은 voice_id 와 다음 fetch 결과가 불일치하는 inconsistent
    // state. 500 으로 즉시 가시화 + 옛 voice cleanup 도 스킵.
    const readyUpdate: Record<string, unknown> = {
      elevenlabs_voice_id: voiceId,
      voice_clone_status: 'ready',
      updated_at: new Date().toISOString(),
    };
    // 재녹음일 때만 카운터 반영 (최초 등록은 카운트 안 함). 가드 비활성(마이그
    // 미적용) 시엔 컬럼을 건드리지 않아 UPDATE 실패를 피한다.
    if (isReRecord && recloneGuardActive) {
      readyUpdate.voice_reclone_count = nextRecloneCount;
      readyUpdate.voice_reclone_window_start = nextWindowStartIso;
    }
    const { error: readyErr } = await supabase
      .from('profiles')
      .update(readyUpdate)
      .eq('id', req.userId!);
    if (readyErr) {
      console.error('[voice.clone.ready_update_failed]', readyErr.message);
      res.status(500).json({ error: 'Voice clone profile update failed' });
      return;
    }

    // 옛 voice 정리 (fire-and-forget) — 새 voice 가 이미 profile 에 set 됐으므로
    // 실패해도 ElevenLabs storage 누적 외 사용자 영향 없음.
    if (prevVoiceId && prevVoiceId !== voiceId) {
      deleteVoiceClone(prevVoiceId).catch((err) => {
        console.error('[Voice Clone] old voice cleanup failed:', prevVoiceId, err);
      });
    }

    // 재생성 직후 버튼이 갱신된 잔여 횟수를 즉시 반영하도록 응답에 reclone 상태
    // 동봉 (GET /status 추가 호출 없이). 최초 등록/가드 비활성 시 next* 는 (0, null)
    // 이라 remaining=cap 로 자연 계산됨.
    const recloneState = computeRecloneState(nextRecloneCount, nextWindowStartIso);
    res.json({
      voice_id: voiceId,
      status: 'ready',
      reclone_remaining: recloneState.remaining,
      reclone_cap: recloneState.cap,
      reclone_reset_at: recloneState.resetAt,
    });
  } catch (error) {
    console.error('[Voice Clone Error]', error);

    await supabase
      .from('profiles')
      .update({ voice_clone_status: 'failed' })
      .eq('id', req.userId!);

    res.status(500).json({ error: 'Voice clone creation failed' });
  }
});

// 클론 상태 확인
router.get('/status', async (req: AuthRequest, res: Response) => {
  // silent-success 룰 (CLAUDE.md): error 가시화. 일시 장애로 SELECT 가 실패하면
  // 사용자에게 'pending' 으로 잘못 표시되어 polling 무한 반복 + UX 혼란.
  // 재녹음 카운터 컬럼(mig 032)까지 한 번에 조회 → FE 가 재녹음 가능 횟수/초기화
  // 날짜를 *미리* 보여줄 수 있게 노출. 컬럼 미존재(마이그 미적용) 시 기본 status 만
  // 재조회하고 reclone 은 풀(cap)로 노출 — 가드 비활성 상태와 일관.
  const { data, error } = await supabase
    .from('profiles')
    .select('voice_clone_status, elevenlabs_voice_id, voice_reclone_count, voice_reclone_window_start')
    .eq('id', req.userId!)
    .single();

  if (error) {
    console.warn('[voice.status.reclone_columns_missing]', error.message);
    const { data: basic, error: basicErr } = await supabase
      .from('profiles')
      .select('voice_clone_status, elevenlabs_voice_id')
      .eq('id', req.userId!)
      .single();
    if (basicErr) {
      console.error('[voice.status.select_failed]', basicErr.message);
      res.status(500).json({ error: basicErr.message });
      return;
    }
    res.json({
      status: basic?.voice_clone_status || 'pending',
      voice_id: basic?.elevenlabs_voice_id,
      reclone_remaining: env.voice.recloneMonthlyCap,
      reclone_cap: env.voice.recloneMonthlyCap,
      reclone_reset_at: null,
    });
    return;
  }

  const reclone = computeRecloneState(
    (data?.voice_reclone_count as number | null) ?? 0,
    (data?.voice_reclone_window_start as string | null) ?? null,
  );

  res.json({
    status: data?.voice_clone_status || 'pending',
    voice_id: data?.elevenlabs_voice_id,
    reclone_remaining: reclone.remaining,
    reclone_cap: reclone.cap,
    reclone_reset_at: reclone.resetAt,
  });
});

// 정책: 사용자 측 단독 voice clone 삭제 라우트는 의도적으로 제거됨.
// 이유: voice clone 없는 발신자(audio_status='pending' 영구) 케이스가 채팅에서
// "메시지 준비 중.." 영구 락을 만드는 회귀의 root cause. 등록 후 삭제 → 메시지
// 송신이 그 경로를 만든다. 사용자가 다시 녹음하고 싶으면 POST /clone 으로
// 덮어쓰기 (서버 측 cleanup 포함). 데이터 삭제권은 계정 탈퇴 라우트
// (auth.ts deleteAccount 의 'elevenlabs-clone' task) 에서 보장한다.

export default router;
