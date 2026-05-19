import { Router, Response } from 'express';
import multer from 'multer';
import { supabase } from '../config/supabase';
import { uploadFile } from '../services/storage';
import { createVoiceClone, deleteVoiceClone } from '../services/elevenlabs';
import { authMiddleware } from '../middleware/auth';
import { requireNotFrozen } from '../utils/freezeGuard';
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
    const { data: prevProfile } = await supabase
      .from('profiles')
      .select('elevenlabs_voice_id')
      .eq('id', req.userId!)
      .single();
    const prevVoiceId = (prevProfile?.elevenlabs_voice_id as string | null) ?? null;

    // 상태를 processing으로 업데이트
    await supabase
      .from('profiles')
      .update({ voice_clone_status: 'processing' })
      .eq('id', req.userId!);

    // ElevenLabs 클론 생성
    const voiceId = await createVoiceClone(req.userId!, req.file.buffer, req.file.originalname);

    // 프로필 업데이트 (새 voice_id 로 덮어쓰기)
    await supabase
      .from('profiles')
      .update({
        elevenlabs_voice_id: voiceId,
        voice_clone_status: 'ready',
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.userId!);

    // 옛 voice 정리 (fire-and-forget) — 새 voice 가 이미 profile 에 set 됐으므로
    // 실패해도 ElevenLabs storage 누적 외 사용자 영향 없음.
    if (prevVoiceId && prevVoiceId !== voiceId) {
      deleteVoiceClone(prevVoiceId).catch((err) => {
        console.error('[Voice Clone] old voice cleanup failed:', prevVoiceId, err);
      });
    }

    res.json({ voice_id: voiceId, status: 'ready' });
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
  const { data } = await supabase
    .from('profiles')
    .select('voice_clone_status, elevenlabs_voice_id')
    .eq('id', req.userId!)
    .single();

  res.json({
    status: data?.voice_clone_status || 'pending',
    voice_id: data?.elevenlabs_voice_id,
  });
});

// 정책: 사용자 측 단독 voice clone 삭제 라우트는 의도적으로 제거됨.
// 이유: voice clone 없는 발신자(audio_status='pending' 영구) 케이스가 채팅에서
// "메시지 준비 중.." 영구 락을 만드는 회귀의 root cause. 등록 후 삭제 → 메시지
// 송신이 그 경로를 만든다. 사용자가 다시 녹음하고 싶으면 POST /clone 으로
// 덮어쓰기 (서버 측 cleanup 포함). 데이터 삭제권은 계정 탈퇴 라우트
// (auth.ts deleteAccount 의 'elevenlabs-clone' task) 에서 보장한다.

export default router;
