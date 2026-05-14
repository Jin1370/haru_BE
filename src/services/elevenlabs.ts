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

export async function synthesizeSpeech(
  text: string,
  voiceId: string,
  emotion?: Exclude<Emotion, 'neutral'> | null
): Promise<Buffer> {
  const prefixed = emotion ? `[${emotion}] ${text}` : text;
  const audioStream = await client.textToSpeech.convert(voiceId, {
    text: prefixed,
    modelId: 'eleven_v3',
    // stability 0.6: 데이팅 톤(차분·다정) 위해 v3 natural(0.5) 보다 살짝 위로
    // 고정. 너무 낮으면 prosody 변동 폭이 커져 "방정맞은" 첫인상.
    // similarityBoost 0.75 명시 (eleven 기본값과 동일하지만, 다국어 합성 시
    // boost 가 너무 높으면 원어 음소가 외국어에 잔존하는 부작용을 차단하기 위해
    // 향후 default 변경 영향에서 코드를 분리. mig 011 voice intro 다국어 합성과
    // 메시지 TTS 모두 동일 설정 공유.
    voiceSettings: { stability: 0.6, similarityBoost: 0.75 },
  });
  return streamToBuffer(audioStream);
}
