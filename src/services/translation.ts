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
CRITICAL — which tag a crying marker takes is decided by the SAME line only:
  - Laughter markers (ㅋ / ㅎ / ｗ / ww / www / 笑 / 草 / haha / hehe / lol / lmao / rofl / xD / :D / =D / 555 / ฮ่าๆ / हाहा / हीही) are ALWAYS [laughs]. Never [sad].
  - Crying markers (ㅠ / ㅜ / T_T / ;_; / Q_Q / :( / :'( ) default to [sad]. They become [laughs] ONLY when the very same "Text to translate" line also says, in words, that something is funny — 웃겨/웃김/웃기다/재밌, 面白い/ウケる, funny/hilarious, or a laughter marker sitting in that same line. Example: "아 진짜 웃겨요ㅠㅠ" → "아 진짜 웃겨요[laughs]" (the line says 웃겨). "시험 망했어ㅠㅠ" → "시험 망했어[sad]".
  - A crying marker on its own ("ㅠㅠ", "T_T"), or on a line with no such words, is ALWAYS [sad] — even if the conversation before it was funny. NEVER let the preceding messages flip it: the sender typed ㅠㅠ on THIS line, and rendering that as ㅋㅋㅋ plus a laughing voice inverts what they expressed. That inversion is the worst failure in this step. When in doubt, [sad].
CRITICAL — precise removal: remove the marker characters completely, leaving no residue. "진짜 웃기네욬ㅋㅋㅋ" → "진짜 웃기네요[laughs]" (the fused 욬 is restored to 요; leaving "욬[laughs]" is WRONG).
Use EXACTLY [laughs] and [sad]. No other tag names, no variants like [laugh].
If the text has no such marker, insert no tag.`;

// 호칭(kinship-style address term) 규칙.
//
// 사고 사례: 연하 일본인 남성의 「お姉さん」이 한국어로 '언니'(여성 화자 전용)로
// 번역·TTS 됨. 원인은 Gemini 에 화자/청자의 성별·나이가 전혀 안 넘어가서 —
// 소스 언어(ja/en)엔 그 구분이 없으니 모델이 기본값을 찍을 수밖에 없었다.
// 아래 규칙 + 프로필 주입으로 "소스 단어를 직역"이 아니라 "타깃 언어 관습으로
// 재계산" 하도록 강제한다.
//
// 사고 사례 2: 영어 "Hi" 가 '오빠 안녕' 으로 번역됨. 위 규칙이 "소스에 호칭이
// 있을 때 어떤 말로 바꿀지" 만 정하고 "없을 때 넣지 말 것" 을 안 막아서, 모델이
// 한국어 대화 관습대로 호칭을 창작했다. audio tag 의 "literal only" 가드와 같은
// 형태로 삽입 금지 규칙을 맨 앞에 둔다.
const ADDRESS_TERM_RULES = `ADDRESS TERMS (kinship-style terms of address) — RECOMPUTE, never transliterate:
CRITICAL — never ADD an address term: the rules below apply ONLY when the source text literally contains a term of address. If the source has none, the translation has none. Never insert 누나/언니/형/오빠/자기/여보 · お姉さん/お兄さん/君 · พี่/น้อง/भैया/दीदी, and never insert the addressee's name, just because the target language often does. "Hi" → "안녕" (NEVER "오빠 안녕"). Adding an address term the source never had is as wrong as producing the wrong one.
The Speaker / Addressee profile lines given in the user message are the ONLY source of truth for gender and age. Never infer gender or age from the source wording, and never carry a source-language address term across literally — the source language often does not encode the distinction the target language requires.
- Korean output: the term depends on the SPEAKER's gender AND the age gap, not on the source word.
  - speaker male → older female: 누나 (NEVER 언니) | older male: 형
  - speaker female → older female: 언니 | older male: 오빠
  - addressee same age or younger: use their name or 너 — NEVER 누나/언니/형/오빠, and do not use 동생 as a vocative.
  - unknown age/gender, or speaker gender "other": drop the kinship term and address them by name or neutrally. Omitting is far safer than guessing — a wrong term implies a wrong gender and is deeply jarring.
- Japanese output: お姉さん/お兄さん are NOT the default rendering of Korean 누나/언니/형/오빠; prefer 名前+さん or second person. Use お姉さん/お兄さん only when the source clearly addresses a stranger that way and the age gap supports it.
- English output: no equivalent exists. NEVER render 오빠/누나/언니/형/お姉さん/お兄さん as "brother"/"sister"/"older sister" — that reads as an actual sibling. Use the name, "you", or drop it.
- Thai output: พี่ (older) / น้อง (younger) are gender-neutral — the speaker's gender does NOT change them. Attach the polite particle by the SPEAKER's gender: male ครับ, female ค่ะ.
- Hindi output: भैया (older male) / दीदी (older female); for a peer use the name. Keep आप/तुम consistent with the source register.
These rules override any literal reading of the source. Producing a term the profile lines contradict is the single worst failure in this task.`;

// 작품명(영화·드라마·노래·책·만화·게임) + 음식명 규칙.
//
// 기존 프롬프트의 "Keep proper nouns in their original form" 은 인명·지명·브랜드엔
// 맞지만 이 둘엔 틀린다. 작품은 각 나라에서 **공식 제목**으로 개봉·출간되고, 음식은
// 각 나라가 **원어의 서로 다른 조각을 빌려와** 정착시키기 때문이다. 직역("장화홍련"
// → "薔薇と紅蓮")도 음차("チャンファホンリョン")도 현지 사용자에겐 검색조차 안 되는
// 문자열이다. 음식 쪽 대표 사례가 감바스 ↔ アヒージョ — 같은 요리인데 한국은 스페인어
// gambas(새우), 일본은 ajillo(마늘기름)를 가져다 써서 두 이름이 겹치는 글자가 없다.
//
// 환각 방지가 이 규칙의 절반이다 — 그럴듯하지만 틀린 이름은 원문을 그대로 두는
// 것보다 나쁘다(원문이면 최소한 검색은 된다). 확신이 없으면 원문 유지를 강제하고,
// "비슷하지만 다른 것"으로 바꿔치기하는 것(된장찌개 → 味噌汁)도 함께 막는다.
const LOCALIZED_NAME_RULES = `LOCALIZED NAMES — creative works (films, dramas, songs, books, manga/webtoons, games) and dish names — use the name established in the target market, never a literal translation:
Output the title under which the work was officially released, published, or distributed in the target language's market, or the name by which the dish is actually known there. Do NOT translate the constituent words literally, and do NOT transliterate phonetically, when an established local name exists.
  - Works, ko→ja: 장화홍련 → 箪笥 | 참교육 → 鉄槌教師 | 기생충 → パラサイト 半地下の家族 (NOT 寄生虫)
  - Works, ja→ko: 箪笥 → 장화홍련 | 鉄槌教師 → 참교육 | 君の名は。 → 너의 이름은.
  - Dishes, ko→ja: 감바스 → アヒージョ | 떡볶이 → トッポギ | 순대 → スンデ
  - Dishes, ja→ko: アヒージョ → 감바스 | お好み焼き → 오코노미야키 | 唐揚げ → 가라아게
  - The same applies to en / th / hi targets.
An established local name is often completely unrelated to the source words — the two markets may have borrowed different parts of the same original foreign name (감바스 from Spanish "gambas", アヒージョ from "ajillo", one dish). That is expected and correct. Prefer it over any literal rendering.
CRITICAL — never invent one: if you are not confident that an established local name exists, keep the source name as it is (romanized only if the target script makes it unreadable) instead of guessing. A plausible-sounding but wrong name is worse than the untranslated original, because the reader can still look the original up.
CRITICAL — never substitute a different thing: map only to the SAME work or the SAME dish. If the target market has no equivalent, keep the source name — do not swap in something merely similar (된장찌개 is NOT 味噌汁).
If a work or dish is known in the target market under its original or English name unchanged, keep that form.`;

export interface AddressParty {
    gender?: string | null; // 'male' | 'female' | 'other'
    birthDate?: string | null; // profiles.birth_date (YYYY-MM-DD)
}

function ageFrom(birthDate?: string | null): number | null {
    if (!birthDate) return null;
    const born = new Date(birthDate);
    if (Number.isNaN(born.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - born.getFullYear();
    const monthDiff = now.getMonth() - born.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age--;
    return age >= 0 && age < 130 ? age : null;
}

function describeParty(label: string, party?: AddressParty): string {
    const gender = party?.gender ?? "unknown gender";
    const age = ageFrom(party?.birthDate);
    return `${label}: ${gender}, ${age === null ? "unknown age" : `${age} years old`}`;
}

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
  - Short messages carry a weak register signal ("괜찮아", "응 그거 무서웠어", "어디야"), but weak is not absent. Do NOT retreat to the polite form when the text is short: a single plain ending (-아/-어/-지/-네/-야/-자, or a bare noun reply inside a casual thread) is enough to REQUIRE casual output. Guessing polite "to be safe" is itself an error — it makes a close conversation suddenly sound distant.
  - The polite default applies ONLY when the source language marks no politeness at all (English, Thai romanized chat, etc.), never as a fallback for "I am not sure".
- Keep personal names, place names, and brand names in their original or properly romanized form. Titles of creative works and dish names are NOT covered by this — they follow the LOCALIZED NAMES rules below.
- Do NOT respond to the content — only translate.
- Return valid JSON only.

CONVERSATION CONTEXT:
The user message may include a "Conversation so far" block holding up to the last 2 messages, oldest first, each labeled Speaker or Addressee. It is CONTEXT ONLY — never translate those lines, never merge them into the output, never reply to them. Translate ONLY the "Text to translate" line.
Use the context to:
  - resolve what a short or elliptical message refers to (dropped subjects, pronouns, one-word replies such as "응", "그거", "ううん", "same") so the translation carries the right referent instead of a vague literal one;
  - keep the register and the way the two people address each other consistent with how the conversation has been going (do not switch a settled 반말 thread into 존댓말 mid-conversation, and vice versa);
  - disambiguate a word with several readings by what is actually being discussed.
NEVER use the context to choose an audio tag. Tags follow the fixed per-marker mapping in STEP 1 and do not change with the surrounding conversation — a ㅠㅠ after a funny exchange is still [sad].
The context lines are shown exactly as they were originally typed, so they may be in a different language from the target, and may already contain [laughs]/[sad] tags — that is normal and is not something to fix.
CRITICAL — context is advisory, never authoritative. Chat messages interleave: the line immediately before this one is often NOT what this message replies to. The other person may have sent something unrelated in between, or the Speaker may be continuing their OWN earlier line from two turns back. So:
  - Translate what the text actually says. Never bend its meaning to fit the context, never pull a topic, noun, or referent out of the context that the text does not itself point to, and never "fix" the text because it changes the subject.
  - When the text reads as a continuation of an earlier Speaker line, treat THAT line as the antecedent even if an Addressee line sits between them. Example: Speaker "오늘 저녁 진짜 맛있었어" / Addressee "혹시 영화 뭐 좋아해?" / text "라멘을 먹었거든" — this continues the dinner, not the film.
  - If the text stands on its own, or fits none of the context lines, ignore the context completely and translate the text alone. Using no context is always safer than using the wrong one.
If no context block is present, translate the text on its own.

${ADDRESS_TERM_RULES}

${LOCALIZED_NAME_RULES}

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

// 직전 대화 2턴. role 은 **번역 대상 메시지의 발신자 기준** — 'speaker' 는 그 사람이
// 직접 쓴 이전 메시지, 'addressee' 는 상대가 쓴 것. 프롬프트의 Speaker/Addressee
// 프로필 라인과 같은 어휘라 모델이 누가 누구인지 따로 추론할 필요가 없다.
// text 는 **작성된 원문 그대로**(번역본 아님) — 실제로 오간 대화가 맥락이다.
export interface MessageContextEntry {
    role: "speaker" | "addressee";
    text: string;
}

function describeContext(context?: MessageContextEntry[]): string {
    if (!context || context.length === 0) return "";
    const lines = context
        .map(
            (c) =>
                `  ${c.role === "speaker" ? "Speaker" : "Addressee"}: ${JSON.stringify(c.text)}`,
        )
        .join("\n");
    return `Conversation so far (context only — DO NOT translate these lines, oldest first):\n${lines}\n`;
}

export async function translateMessage(params: {
    text: string;
    targetLanguage: string;
    speaker?: AddressParty;
    addressee?: AddressParty;
    context?: MessageContextEntry[];
}): Promise<{ translation: string }> {
    const userPrompt = `Target language: ${params.targetLanguage}
${describeParty("Speaker (who wrote this message)", params.speaker)}
${describeParty("Addressee (who reads it)", params.addressee)}
${describeContext(params.context)}Text to translate: ${JSON.stringify(params.text)}`;

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
- Preserve the speaker's intent, mood, and playful tone. Voice intros are typically 80-160 characters and aim to invite a stranger to swipe right.
- "Playful/friendly" describes TONE and word choice — it is NOT a licence to lower the politeness level. A 해요체 or です・ます intro can be every bit as warm and inviting. Never drop to 반말 / plain form just to sound friendlier; follow the register rules below instead.
- Match natural spoken length within ±20% of the source character count. Do NOT pad or truncate to extremes.
- Register — MIRROR the source, never normalize in either direction:
  - Korean: if the source is 반말, the output MUST be 반말. If the source is polite, use 해요체; avoid stiff 습니다체 unless the source is clearly formal. Only when the source language marks no politeness (e.g. English) default to 해요체.
  - Japanese: mirror likewise — casual source MUST stay casual (だ/だよ/だし), polite source → です/ます. Only when the source marks no politeness default to です/ます.
  - English: contemporary conversational tone, contractions allowed (I'm, you'll). No "thee/thou", no business-speak.
  - CRITICAL for a source language with no politeness marking (English above all): a voice intro is heard by STRANGERS browsing profiles, so the unmarked default is the polite one — 해요체 for Korean, です・ます for Japanese. "Hi! Nice to meet you" must become "안녕하세요! 만나서 반가워요" — NEVER "안녕~ 만나서 반가워!". Never infer 반말 / plain form from the informality of English wording; English is informal by default and says nothing about Korean or Japanese politeness.
- Preserve personal names, place names, brand names, emoji, and onomatopoeia (e.g., 두근두근, ドキドキ). Titles of creative works and dish names are NOT covered by this — they follow the LOCALIZED NAMES rules below (voice intros often name a favourite film, drama, or food).
- Do NOT translate hashtags or @mentions if present.
- Do NOT add any new content the speaker did not say (no extra greetings, no sign-offs).
- Output VALID JSON only.

${LOCALIZED_NAME_RULES}

${ADDRESS_TERM_RULES}
A voice intro has no single addressee — there is no Addressee profile line. When the source refers to the kind of person the speaker is looking for (e.g. 年上のお姉さん / 연하남), pick the term from the SPEAKER's gender plus the older/younger direction stated in the source (male speaker + older woman → 누나, never 언니). If the direction is not stated, use a neutral phrasing instead of guessing a kinship term.

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
    speaker?: AddressParty;
}): Promise<{
    translations: Partial<Record<VoiceIntroSlotLanguage, string>>;
    detectedSourceLanguage: string;
}> {
    if (params.targetLanguages.length === 0) {
        return { translations: {}, detectedSourceLanguage: params.sourceLanguage };
    }

    const userPrompt = `Source language: ${params.sourceLanguage}
Target languages: ${JSON.stringify(params.targetLanguages)}
${describeParty("Speaker (who recorded this intro)", params.speaker)}
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
