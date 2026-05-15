import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { env } from '../config/env';
import { Emotion } from '../types';

const client = new ElevenLabsClient({ apiKey: env.elevenlabs.apiKey });

export async function createVoiceClone(
  userId: string,
  audioBuffer: Buffer,
  fileName: string
): Promise<string> {
  const audioBlob = new Blob([audioBuffer as unknown as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
  const file = new File([audioBlob], fileName, { type: 'audio/wav' });

  const voice = await client.voices.ivc.create({
    name: `user_${userId}`,
    files: [file],
    removeBackgroundNoise: true,
  });

  return voice.voiceId;
}

export async function deleteVoiceClone(voiceId: string): Promise<void> {
  await client.voices.delete(voiceId);
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// 데이팅 톤 페르소나 — 발신자 성별 기반 vocal style tag.
// 'other' / null / undefined 는 태그 없음. mig 011 voice intro 다국어 합성
// 시 도입됐고, 메시지 TTS 도 동일 페르소나를 공유하도록 본 서비스로 이동.
export type PersonaGender = 'male' | 'female' | 'other' | null | undefined;

function buildPersonaTag(gender: PersonaGender): string {
  if (gender === 'male') return '[warm, gently] ';
  if (gender === 'female') return '[sweetly, smiling] ';
  return '';
}

export async function synthesizeSpeech(
  text: string,
  voiceId: string,
  emotion?: Exclude<Emotion, 'neutral'> | null,
  gender?: PersonaGender,
): Promise<Buffer> {
  // 태그 순서: persona (발신자 baseline 캐릭터) → emotion (이 발화의 modifier).
  const personaTag = buildPersonaTag(gender);
  const emotionTag = emotion ? `[${emotion}] ` : '';
  const prefixed = `${personaTag}${emotionTag}${text}`;
  const audioStream = await client.textToSpeech.convert(voiceId, {
    text: prefixed,
    modelId: 'eleven_v3',
    // stability 1.0: 최대 안정성 (v3 Robust 프리셋). prosody 변동 폭 최소화.
    // similarityBoost 0.75 명시 (eleven 기본값과 동일하지만, 다국어 합성 시
    // boost 가 너무 높으면 원어 음소가 외국어에 잔존하는 부작용을 차단하기 위해
    // 향후 default 변경 영향에서 코드를 분리. mig 011 voice intro 다국어 합성과
    // 메시지 TTS 모두 동일 설정 공유.
    voiceSettings: { stability: 1.0, similarityBoost: 0.75 },
  });
  return streamToBuffer(audioStream);
}
