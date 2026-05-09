import { Router, Response } from 'express';
import multer from 'multer';
import { supabase } from '../config/supabase';
import { uploadFile } from '../services/storage';
import { createVoiceClone, deleteVoiceClone } from '../services/elevenlabs';
import { authMiddleware } from '../middleware/auth';
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
router.post('/clone', upload.single('audio'), async (req: AuthRequest, res: Response) => {
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
    // 상태를 processing으로 업데이트
    await supabase
      .from('profiles')
      .update({ voice_clone_status: 'processing' })
      .eq('id', req.userId!);

    const path = `${req.userId!}.wav`;
    const voiceSampleUrl = await uploadFile('voice-samples', path, req.file.buffer, req.file.mimetype);

    // ElevenLabs 클론 생성
    const voiceId = await createVoiceClone(req.userId!, req.file.buffer, req.file.originalname);

    // 프로필 업데이트
    await supabase
      .from('profiles')
      .update({
        elevenlabs_voice_id: voiceId,
        voice_sample_url: voiceSampleUrl,
        voice_clone_status: 'ready',
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.userId!);

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

// 클론 삭제
router.delete('/clone', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('profiles')
    .select('elevenlabs_voice_id')
    .eq('id', req.userId!)
    .single();

  if (data?.elevenlabs_voice_id) {
    await deleteVoiceClone(data.elevenlabs_voice_id);
  }

  await supabase
    .from('profiles')
    .update({
      elevenlabs_voice_id: null,
      voice_clone_status: 'pending',
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.userId!);

  res.json({ status: 'deleted' });
});

export default router;
