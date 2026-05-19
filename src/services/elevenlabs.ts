import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { SILENCE_TAIL } from "../assets/silenceTail";
import { env } from "../config/env";
import { Emotion } from "../types";

const client = new ElevenLabsClient({ apiKey: env.elevenlabs.apiKey });

export async function createVoiceClone(
    userId: string,
    audioBuffer: Buffer,
    fileName: string,
): Promise<string> {
    const audioBlob = new Blob(
        [audioBuffer as unknown as Uint8Array<ArrayBuffer>],
        { type: "audio/wav" },
    );
    const file = new File([audioBlob], fileName, { type: "audio/wav" });

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

async function streamToBuffer(
    stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
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
//
// tag 선택 원칙: pitch 변경 tag 회피. delivery·감정 tag 로 톤의 성격만 가산해
// 원본 음색 유사도 보존.
// - male: softly + warmly (차분·부드러움 + 따뜻함, 방정맞음 차단).
// - female: sweetly + cutely (다정 + 애교).
export type PersonaGender = "male" | "female" | "other" | null | undefined;

function buildPersonaTag(gender: PersonaGender): string {
    if (gender === "male") return "[softly, warmly] ";
    if (gender === "female") return "[sweetly, cutely] ";
    return "";
}

// 언어별 accent / 발음 가이드 tag. 영어 합성 시 v3 multilingual 의 기본
// British/RP 경향을 American 으로 교정. 비영어권 (ko/ja/th/hi) 은 accent tag
// 자체를 부착하지 않아 native 발음을 유지.
function buildAccentTag(targetLanguage: string | null | undefined): string {
    if (targetLanguage === "en") return "[strong American accent] ";
    return "";
}

export async function synthesizeSpeech(
    text: string,
    voiceId: string,
    emotion?: Exclude<Emotion, "neutral"> | null,
    gender?: PersonaGender,
    targetLanguage?: string | null,
): Promise<Buffer> {
    // v3 (eleven_v3) 는 audio tag / persona tag 네이티브 지원 — bracket 안의
    // 단어를 효과음·톤 modifier 로 해석. text 의 [laughs]/[sad] 인라인 태그와
    // buildPersonaTag/buildAccentTag/emotionTag prefix 모두 그대로 전달.
    // tag 적용 순서: persona (성별 baseline) → accent (언어별 발음 교정) →
    // emotion (이 발화의 modifier). 모두 별도 bracket — v3 가 각 instruction
    // 을 독립적으로 인식하도록.
    // v2 로 revert 시: prefixed 대신 prefixed.replace(/\[[^\]]+\]\s*/g, '') + modelId 복귀.
    const personaTag = buildPersonaTag(gender);
    const accentTag = buildAccentTag(targetLanguage);
    const emotionTag = emotion ? `[${emotion}] ` : "";
    // eleven_v3 는 종결 prosody 를 빠르게 마무리해 마지막 음절이 잘려 들리는
    // 경향이 있음 (특히 stability=1.0 Robust + 종결 punctuation 부재 시).
    // 텍스트 끝에 종결 punctuation 이 없으면 ellipsis 를 부착해 모델이 학습한
    // "문장 끝" 분포대로 자연 fade-out 을 유도. audio tag (`[laughs]` 등) 로
    // 끝나는 경우에도 효과음 직후 trailing silence 가 따라붙어 잘림 완화.
    const trimmedText = text.trimEnd();
    const hasTerminalPunctuation = /[.!?…。！？]$/.test(trimmedText);
    const paddedText = hasTerminalPunctuation ? trimmedText : `${trimmedText}…`;
    const prefixed = `${personaTag}${accentTag}${emotionTag}${paddedText}`;
    const audioStream = await client.textToSpeech.convert(voiceId, {
        text: prefixed,
        modelId: "eleven_v3",
        // v3 최선 프리셋 (데이팅 클론 TTS, 차별점 2):
        // v3 는 실질적으로 stability 만 honor (대시보드 UI / Smartbox·Scenario
        // 가이드 / 실증 테스트로 확인). similarityBoost / style / speed /
        // useSpeakerBoost 는 API 가 받지만 모델이 무시. expressiveness 와 정체성
        // 제어는 voiceSettings 가 아닌 (1) stability 프리셋 (2) audio tag
        // (persona/emotion) (3) 텍스트 punctuation 으로 한다.
        // - stability 1.0: Robust 프리셋. take 간 prosody 변동 최소화, 최대 안정.
        //   참고: 일부 커뮤니티 글이 "Robust 는 audio tag 무시" 라고 주장하지만
        //   실증 테스트상 tag 가 honor 됨 (효과가 Natural 0.5 보다 약할 수는
        //   있음). 대안: 0.5 Natural (균형), 0.0 Creative (최대 expressiveness).
        voiceSettings: { stability: 1.0 },
    });
    const speech = await streamToBuffer(audioStream);
    // eleven_v3 는 합성 stream 마지막 ~0.2초 trailing silence 없이 잘라내는
    // 경향이 있음 (모델 동작, stability 프리셋 무관). 텍스트 종결 punctuation
    // padding (paddedText) 으로도 완전히 해결되지 않아 출력 buffer 뒤에
    // 500ms 무음 MP3 frame 을 직접 concat 해 청취 잘림을 100% 차단.
    // ID3/Xing 헤더 없는 LAME MP3 라 binary concat 안전 (assets/silenceTail.ts).
    return Buffer.concat([speech, SILENCE_TAIL]);
}
