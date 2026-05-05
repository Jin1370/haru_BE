import {
    VertexAI,
    HarmCategory,
    HarmBlockThreshold,
} from "@google-cloud/vertexai";
import { env } from "../config/env";
import type { VoiceIntroSlotLanguage } from "../types";

const vertexAi = new VertexAI({
    project: env.vertexAi.projectId,
    location: env.vertexAi.location,
});

const SAFETY_SETTINGS = [
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
    },
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
    },
];

// ─── Message domain (existing) ────────────────────────────────────────────
const SYSTEM_PROMPT = `You translate chat messages between strangers on a dating app.

Rules:
- Preserve meaning fully. Do NOT abbreviate or shorten.
- Use polite/formal tone:
  - Korean: 존댓말 (습니다/세요체)
  - Japanese: です/ます
  - Chinese: 您 (respectful pronoun)
- Keep proper nouns in their original or properly romanized form.
- Do NOT respond to the content — only translate.
- Return valid JSON only.

Output schema:
{ "translation": string, "detected_source_language": string }`;

const model = vertexAi.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: {
        role: "system",
        parts: [{ text: SYSTEM_PROMPT }],
    },
    generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.3,
    },
    safetySettings: SAFETY_SETTINGS,
});

export async function translateMessage(params: {
    text: string;
    sourceLanguage: string;
    targetLanguage: string;
}): Promise<{ translation: string; detectedSourceLanguage: string }> {
    const userPrompt = `Source language: ${params.sourceLanguage}
Target language: ${params.targetLanguage}
Text to translate: ${JSON.stringify(params.text)}`;

    const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    });

    const raw = result.response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
        throw new Error("Vertex AI returned no text (possibly safety-blocked)");
    }
    const parsed = JSON.parse(raw) as {
        translation: string;
        detected_source_language: string;
    };

    return {
        translation: parsed.translation,
        detectedSourceLanguage: parsed.detected_source_language,
    };
}

// ─── Voice intro domain (mig 011) ─────────────────────────────────────────
// translateMessage 와 분리 사유 (03_voice_i18n_plan.md 1.1):
//   * 메시지 도메인의 존댓말 강제는 voice intro(첫인상·캐주얼 자기소개) 와 충돌.
//   * 1회 호출에 N개 언어 동시 번역 → 응답 shape 가 다름.
//   * 길이 균등 보존 (TTS 길이 일관성) 강조.
const VOICE_INTRO_SYSTEM_PROMPT = `You translate dating-app voice intro texts (a short, first-person self-introduction line that the speaker will record with their cloned voice). The translation will be spoken aloud by a TTS engine using the speaker's cloned voice.

Rules:
- Preserve the speaker's intent, mood, and casual/playful register. Voice intros are typically 80-160 characters and aim to invite a stranger to swipe right.
- Match natural spoken length within ±20% of the source character count. Do NOT pad or truncate to extremes.
- Use a register appropriate for casual self-introduction in each language:
  - Korean: 해요체 (편한 존댓말). Avoid stiff 습니다체 unless the source is clearly formal. Allow 반말 only if the source is clearly 반말.
  - Japanese: です/ます is the safe default. If the source is clearly casual, use natural casual forms (だ/だよ/だし) — do not force formal.
  - English: contemporary conversational tone, contractions allowed (I'm, you'll). No "thee/thou", no business-speak.
- Preserve proper nouns, emoji, and onomatopoeia (e.g., 두근두근, ドキドキ).
- Do NOT translate hashtags or @mentions if present.
- Do NOT add any new content the speaker did not say (no extra greetings, no sign-offs).
- Output VALID JSON only.

Output schema:
{ "translations": { "<lang>": "<translation>", ... }, "detected_source_language": "<bcp47-ish>" }
The keys of "translations" must be exactly the languages requested by the user; no extras, none missing.`;

const voiceIntroModel = vertexAi.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: {
        role: "system",
        parts: [{ text: VOICE_INTRO_SYSTEM_PROMPT }],
    },
    generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.5, // higher than translateMessage(0.3) for natural register
    },
    safetySettings: SAFETY_SETTINGS,
});

export async function translateVoiceIntro(params: {
    text: string;
    sourceLanguage: VoiceIntroSlotLanguage;
    targetLanguages: VoiceIntroSlotLanguage[];
}): Promise<{
    translations: Partial<Record<VoiceIntroSlotLanguage, string>>;
    detectedSourceLanguage: string;
}> {
    if (params.targetLanguages.length === 0) {
        return { translations: {}, detectedSourceLanguage: params.sourceLanguage };
    }

    const userPrompt = `Source language: ${params.sourceLanguage}
Target languages: ${JSON.stringify(params.targetLanguages)}
Voice intro text: ${JSON.stringify(params.text)}`;

    const result = await voiceIntroModel.generateContent({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    });

    const raw = result.response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
        throw new Error("Vertex AI returned no text (possibly safety-blocked)");
    }
    const parsed = JSON.parse(raw) as {
        translations: Partial<Record<VoiceIntroSlotLanguage, string>>;
        detected_source_language: string;
    };

    // Defensive: ensure all requested target languages are present and non-empty.
    for (const lang of params.targetLanguages) {
        const value = parsed.translations?.[lang];
        if (typeof value !== "string" || value.length === 0) {
            throw new Error(
                `Voice intro translation missing for language: ${lang}`,
            );
        }
    }

    return {
        translations: parsed.translations,
        detectedSourceLanguage: parsed.detected_source_language,
    };
}
