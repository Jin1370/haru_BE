import {
    VertexAI,
    HarmCategory,
    HarmBlockThreshold,
} from "@google-cloud/vertexai";
import { env } from "../config/env";
import { sanitizeAudioTags } from "../utils/textNormalization";
import type { VoiceIntroSlotLanguage } from "../types";

// Shared STEP 1 instruction block (emotion marker → audio tag). Both the message
// and voice-intro prompts embed this before their translation rules so tagging and
// translation happen in a single Gemini call (regex prepareTextForTTS 폐지).
const AUDIO_TAG_STEP = `STEP 1 — Emotion audio tags (do this FIRST, before translating):
Some chat text contains typed "emotion markers": laughter or crying rendered as repeated jamo / letters / kaomoji rather than as words. Replace ONLY these literally-present markers with an inline audio tag, and delete the marker characters from the text.
  - laughter marker  → [laughs]
  - crying / sadness marker → [sad]
Markers to detect, across every language:
  - Korean: ㅋ or ㅎ (single or repeated), INCLUDING a trailing ㅋ/ㅎ fused into a syllable's final consonant — e.g. 욬 = 요 + ㅋ, 큨 = 큐 + ㅋ, 릌 = 리 + ㅋ. Restore the base syllable and move the laughter into [laughs] (e.g. 웃기네욬ㅋㅋ → 웃기네요[laughs]). Same for ㅠ or ㅜ (single or repeated, incl. fused) → [sad].
  - Japanese: ｗ / ww / www, 笑 or （笑）, 草 (but NOT 笑顔 or 微笑 which mean "smile" — leave those untouched).
  - English: hahaha / hehe / lol / lmao / rofl; kaomoji xD / :D / =D → [laughs]; :( / :'( / T_T / ;_; / Q_Q → [sad].
  - Thai: 555, ฮ่าๆ → [laughs].
  - Hindi: हाहा, हीही → [laughs].
CRITICAL — literal only: insert a tag ONLY when such a marker literally appears. NEVER infer emotion from meaning. "아 오늘 너무 슬프다" (sad in meaning, NO marker) stays "아 오늘 너무 슬프다" with no tag. "아 오늘 너무 슬프다ㅠㅠ" becomes "아 오늘 너무 슬프다[sad]".
CRITICAL — context chooses WHICH tag: the marker must still literally appear (never invent a tag from meaning alone), but whether it becomes [laughs] or [sad] follows the emotion the marker conveys IN CONTEXT, not its usual default. Korean ㅠㅠ / ㅜㅜ (and T_T) very often mean "crying FROM laughter" — when the surrounding text is about something funny, tag them [laughs], NOT [sad]. Example: "아 진짜 웃겨요ㅠㅠ" → "아 진짜 웃겨요[laughs]". Use [sad] only when the context is genuinely sad ("시험 망했어ㅠㅠ" → "시험 망했어[sad]"). With no such contextual signal, fall back to each marker's usual emotion (ㅋ/ㅎ/ww/haha/xD → [laughs]; ㅠ/ㅜ/T_T → [sad]).
CRITICAL — precise removal: remove the marker characters completely, leaving no residue. "진짜 웃기네욬ㅋㅋㅋ" → "진짜 웃기네요[laughs]" (the fused 욬 is restored to 요; leaving "욬[laughs]" is WRONG).
Use EXACTLY [laughs] and [sad]. No other tag names, no variants like [laugh].
If the text has no such marker, insert no tag.`;

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
const SYSTEM_PROMPT = `You process chat messages between strangers on a dating app in two steps: first tag emotion markers as audio tags, then translate.

${AUDIO_TAG_STEP}

STEP 2 — Translate the tagged text into the target language:
- Always render the text as a native speaker of the target language would naturally write it — regardless of what language the source appears to be in. Do not skip this step or return the input unchanged just because it looks short, simple, or superficially similar to the target language.
- The "target language" refers only to what language the OUTPUT must be written in. It has nothing to do with what the message is about. A message that mentions a country, nationality, or language by name (e.g. asking "Are you Korean?" or "Do you speak Japanese?") must still be fully translated into the target language — do not treat topical references to the target language/country as if the text were already written in it.
- Sound like a real person texting someone they're interested in — warm, natural, and conversational. NEVER translate word-for-word. Render what a native speaker would actually type in this situation, not a literal gloss.
- Translate interjections and emotional expressions to their natural target-language equivalent, NOT their dictionary form. Examples (en→ko): "Aww" → "아유~"/"아~" (affection, NOT "아이고~" which sounds like dismay); "Haha" → "ㅋㅋ"; "Oh no" → "헐"/"이런". Pick the equivalent that carries the same warmth.
- The source may be broken, abbreviated, or grammatically off (typos, dropped words like "that me smile" meaning "that made me smile"). Infer the intended meaning and translate that naturally — do NOT reproduce the brokenness.
- Preserve meaning and emotional intent fully. Do NOT abbreviate or shorten.
- CRITICAL: Inline ElevenLabs audio tags written as [laughs], [sad], or similar [single_word] forms in square brackets, are SOUND EFFECT MARKERS — not text. You MUST preserve them verbatim in their original position. Do NOT translate them, do NOT remove them, do NOT replace them with native onomatopoeia like ㅋㅋ or 笑 or ㅠㅠ or (泣).
- Match the source register — MIRROR it, never normalize toward polite:
  - Korean: if the source is 반말, the output MUST be 반말 (e.g. "일찍 일어나는 이유가 있어?" must NOT become "...있어요?"). If the source is polite, use 해요체; avoid stiff 습니다체 unless the source is clearly formal. Only when the source language marks no politeness (e.g. English) default to 해요체.
  - Japanese: mirror likewise — casual source MUST stay casual (だ/だよ/だし), polite source → です/ます. Only when the source marks no politeness default to です/ます.
  - English: contemporary conversational tone, contractions allowed (I'm, you'll). No business-speak.
  - Chinese: 您 by default. Allow 你 if the source is clearly casual.
- Keep proper nouns in their original or properly romanized form.
- Do NOT respond to the content — only translate.
- Return valid JSON only.

Output schema:
{ "translation": string }`;

const model = vertexAi.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: {
        role: "system",
        parts: [{ text: SYSTEM_PROMPT }],
    },
    generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.4,
    },
    safetySettings: SAFETY_SETTINGS,
});

export async function translateMessage(params: {
    text: string;
    targetLanguage: string;
}): Promise<{ translation: string }> {
    const userPrompt = `Target language: ${params.targetLanguage}
Text to translate: ${JSON.stringify(params.text)}`;

    const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    });

    const raw = result.response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
        throw new Error("Vertex AI returned no text (possibly safety-blocked)");
    }
    const parsed = JSON.parse(raw) as { translation: string };

    // 화이트리스트 검증 — Gemini 가 규율 이탈 태그를 emit 해도 TTS/UI 오염 차단.
    return { translation: sanitizeAudioTags(parsed.translation) };
}

// ─── Voice intro domain (mig 011) ─────────────────────────────────────────
// translateMessage 와 분리 사유 (03_voice_i18n_plan.md 1.1):
//   * register 정책 차이 — 메시지는 register-preserving(소스가 캐주얼이면 캐주얼), voice intro 는 더 적극적으로 캐주얼/playful 톤 유지 + ±20% 길이 보존.
//   * 1회 호출에 N개 언어 동시 번역 → 응답 shape 가 다름.
//   * 길이 균등 보존 (TTS 길이 일관성) 강조.
const VOICE_INTRO_SYSTEM_PROMPT = `You process dating-app voice intro texts (a short, first-person self-introduction line the speaker records with their cloned voice) in two steps: first tag emotion markers as audio tags, then render each requested language. Output will be spoken aloud by a TTS engine using the speaker's cloned voice.

${AUDIO_TAG_STEP}

STEP 2 — Produce the tagged text in every requested language:
- Apply STEP 1 tagging to the source text, then translate the tagged text into each requested language. A requested language equal to the source language must be returned with the STEP 1 tags applied but otherwise unchanged (do NOT re-translate it).
- CRITICAL: Inline ElevenLabs audio tags written as [laughs], [sad], or similar [single_word] forms in square brackets, are SOUND EFFECT MARKERS — not text. You MUST preserve them verbatim in their original position. Do NOT translate them, do NOT remove them, do NOT replace them with native onomatopoeia like ㅋㅋ or 笑 or ㅠㅠ or (泣).
- Preserve the speaker's intent, mood, and casual/playful register. Voice intros are typically 80-160 characters and aim to invite a stranger to swipe right.
- Match natural spoken length within ±20% of the source character count. Do NOT pad or truncate to extremes.
- Use a register appropriate for casual self-introduction in each language — MIRROR the source register, never normalize toward polite:
  - Korean: if the source is 반말, the output MUST be 반말. If the source is polite, use 해요체; avoid stiff 습니다체 unless the source is clearly formal. Only when the source language marks no politeness (e.g. English) default to 해요체.
  - Japanese: mirror likewise — casual source MUST stay casual (だ/だよ/だし), polite source → です/ます. Only when the source marks no politeness default to です/ます.
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
        temperature: 0.5, // higher than translateMessage(0.4) for natural register
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

    // Sanitize (화이트리스트 검증) each slot, then require all requested target
    // languages present + non-empty. A slot that is only a bad tag (sanitized to
    // empty) is treated as missing.
    const translations: Partial<Record<VoiceIntroSlotLanguage, string>> = {};
    for (const lang of params.targetLanguages) {
        const value = parsed.translations?.[lang];
        const clean =
            typeof value === "string" ? sanitizeAudioTags(value) : value;
        if (typeof clean !== "string" || clean.length === 0) {
            throw new Error(
                `Voice intro translation missing for language: ${lang}`,
            );
        }
        translations[lang] = clean;
    }

    return {
        translations,
        detectedSourceLanguage: parsed.detected_source_language,
    };
}
