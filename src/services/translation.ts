import {
    VertexAI,
    HarmCategory,
    HarmBlockThreshold,
} from "@google-cloud/vertexai";
import { env } from "../config/env";
import { sanitizeAudioTags, stripAudioTags, URL_PATTERN } from "../utils/textNormalization";
import { retryOnce } from "../utils/retry";
import type { VoiceIntroSlotLanguage } from "../types";

// Shared STEP 1 instruction block (emotion marker → audio tag). Both the message
// and voice-intro prompts embed this before their translation rules so tagging and
// translation happen in a single Gemini call (regex prepareTextForTTS 폐지).
const audioTagStep = (n: number) => `STEP ${n} — Emotion audio tags (tag markers BEFORE any repair or translation):
Some chat text contains typed "emotion markers": laughter or crying rendered as repeated jamo / letters / kaomoji rather than as words. Replace ONLY these literally-present markers with an inline audio tag, and delete the marker characters from the text.
  - laughter marker  → [soft laugh]
  - crying / sadness marker → [sad]
Markers to detect, across every language:
  - Korean: ㅋ or ㅎ (single or repeated), INCLUDING a trailing ㅋ/ㅎ fused into a syllable's final consonant — e.g. 욬 = 요 + ㅋ, 큨 = 큐 + ㅋ, 릌 = 리 + ㅋ. Restore the base syllable and move the laughter into [soft laugh] (e.g. 웃기네욬ㅋㅋ → 웃기네요[soft laugh]). Same for ㅠ or ㅜ (single or repeated, incl. fused) → [sad].
  - Japanese: ｗ / ww / www, 笑 or （笑）, 草 (but NOT 笑顔 or 微笑 which mean "smile" — leave those untouched).
  - English: hahaha / hehe / lol / lmao / rofl; kaomoji xD / :D / =D → [soft laugh]; :( / :'( / T_T / ;_; / Q_Q → [sad].
  - Thai: 555, ฮ่าๆ → [soft laugh].
  - Hindi: हाहा, हीही → [soft laugh].
CRITICAL — literal only: insert a tag ONLY when such a marker literally appears. NEVER infer emotion from meaning. "아 오늘 너무 슬프다" (sad in meaning, NO marker) stays "아 오늘 너무 슬프다" with no tag. "아 오늘 너무 슬프다ㅠㅠ" becomes "아 오늘 너무 슬프다[sad]".
CRITICAL — precise removal: remove the marker characters completely, leaving no residue. "진짜 웃기네욬ㅋㅋㅋ" → "진짜 웃기네요[soft laugh]" (the fused 욬 is restored to 요; leaving "욬[soft laugh]" is WRONG).
Use EXACTLY [soft laugh] and [sad]. No other tag names, no variants like [laughs] or [laugh].
If the text has no such marker, insert no tag.`;

// TTS 입력 직전 교정 단계. 메시지와 보이스 한마디 둘 다 합성 대상이라 규칙이 같다
// — 오타·초성체가 그대로 합성되면 깨지거나 뜻 없는 소리가 난다. 태그 삽입 스텝
// 번호가 프롬프트마다 달라(메시지 2 / 보이스 인트로 1) 본문은 번호를 참조하지 않는다.
const repairStep = (n: number) => `STEP ${n} — Repair (never touch the audio tags):
The result of this step is what the TTS engine reads aloud, so a typo or a letters-only abbreviation comes out as broken or meaningless sound. Fix ONLY what is unambiguous:
- Obvious typos and dropped/duplicated letters: 고맙급니다 → 고맙습니다 | 고맙습다 → 고맙습니다 | "that me smile" → "that made me smile".
- Chat abbreviations written as bare letters, expanded to the word they stand for: ㄷㄱㄷㄱ → 두근두근 | ㄱㄱ → 고고 | ㅇㅈ → 인정 | thx → thanks.
- Do NOT change spacing. Spacing does not affect how the text is read aloud, and re-spacing makes an otherwise unchanged message look edited.
- Do NOT change word choice, sentence endings, politeness level, dialect, emoji, or the audio tags. This step repairs, it does not rewrite.
- URLs, email addresses and @handles: copy them character-for-character, here and in every later step including translation. Never "fix" a typo inside one, never translate or transliterate words inside a path, never re-space or shorten one. A changed link is a dead link.
- When in doubt, leave the text exactly as it is. A confident wrong "correction" is worse than an uncorrected typo — it changes what the sender said.`;

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

// 참가자 닉네임 규칙.
//
// 사고 사례: 닉네임이 '시부'인 일본인에게 보낸 '시부님은 어때요?' 가 ja 로
// '義父さん(시아버지)'으로 번역됨. 원인은 Gemini 에 두 사람의 display_name 이
// 전혀 안 넘어가서 — '시부'는 한국어 사전에 실제로 있는 단어(媤父)이고 '님'까지
// 붙어 있으니 보통명사 읽기가 가장 그럴듯했다. STEP 4 의 "Keep personal names"
// 규칙은 있었지만 무엇이 이름인지 알 데이터가 없어 발동 자체가 불가능했다.
//
// 반대 방향도 같은 구조로 뚫린다(ハル·사랑·가을 …). 그래서 프로필 라인에 이름을
// 주입하고, 보통명사 읽기보다 이름 읽기를 우선하도록 강제한다. 단 이름이 진짜
// 일반 단어로 쓰인 경우("하루 종일")까지 얼리면 그것도 오역이라 가드를 같이 둔다.
const PARTICIPANT_NAME_RULES = `PARTICIPANT NAMES — the names in the profile lines are PROPER NOUNS:
The Speaker / Addressee profile lines may carry that person's display name. In this conversation those strings are names, even when the same string is also an ordinary word or a kinship term in some language — Korean 시부 also means "father-in-law", 하루 also means "a day", 사랑 also means "love"; Japanese カレン, ハル likewise.
- When the text refers to one of these two people by that name — typically with an honorific suffix (님 / 씨 / さん / くん / ちゃん) or standing in a vocative or subject position — keep it as a NAME. NEVER render it as the common noun. "시부님은 어때요?" addressed to the person named 시부 is "シブさんはどうです？", NEVER "義父さんは…".
- Keep the name in its original form; transliterate into the target script only when the original script would be unreadable there (시부 → シブ, しぶ → 시부). Never translate its literal meaning.
- Guard against over-applying: if the same string is plainly used as an ordinary word and not as a reference to that person ("하루 종일" = "all day long"), translate it normally. Judge by how the text uses it.
- These names are given for RECOGNITION ONLY. Never insert a name that the source text does not contain (see ADDRESS TERMS).`;

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
    name?: string | null; // profiles.display_name — PARTICIPANT_NAME_RULES 참고
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
    // 닉네임은 사용자 입력이라 JSON 인용부호로 감싼다 (zod 가 1~50자·단일행·제어문자
    // 금지로 막고 있어 프롬프트 구조는 못 깨지만, 이름의 경계를 명시해야 모델이
    // 어디까지가 이름인지 안다).
    const name = party?.name?.trim();
    const namePart = name ? `name ${JSON.stringify(name)}, ` : "";
    return `${label}: ${namePart}${gender}, ${age === null ? "unknown age" : `${age} years old`}`;
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
const JA_REGISTER_RULE = `  - Japanese: mirror likewise — casual source MUST stay casual (だ/だよ/だし), polite source → です/ます. Only when the source marks no politeness default to です/ます.
    Polite here means the SOFT conversational です/ます that adults use when texting or chatting, NOT textbook/business keigo. Korean 해요체 maps to this soft form, never to stiff 습니다체-equivalents:
    - Questions: drop the question-marker か and end on the verb/です with a rising "？" — "아침은 먹었어요?" → "朝ごはんは食べました？" (NEVER "食べましたか？"); "어때요?" → "どうです？" (NEVER "どうですか？"); "뭐 하세요?" → "何してます？" (NEVER "何をしますか？"). This applies to EVERY question in the text, not only the last sentence. "〜ますか？/〜ですか？" must not appear in the output.
    - Use conversational sentence-final particles (〜ですね / 〜ですよ / 〜ますよね) where a native speaker would; ALWAYS use contracted forms — 〜てます (NEVER 〜ています), 〜ちゃいました (NEVER 〜てしまいました), 〜なきゃ (NEVER 〜なければ), 〜と思ってます / 〜つもりです (NEVER 〜と思っています).
    - Never use でしょうか / 〜でございます / 〜いたします / お〜になる / honorific verb forms (〜されてる, 〜なさる, いらっしゃる) or other keigo — those read as customer service, not a person you're getting to know. This includes the no-politeness default: "What do you do for work?" → "お仕事は何してます？" (NEVER "何をされていますか？").`;

const SYSTEM_PROMPT = `You process chat messages between strangers on a dating app in four steps: decide whether it is already in the target language, tag emotion markers, repair what a TTS engine would mispronounce, then render.

STEP 1 — Language check (do this FIRST; the result drives STEP 4):
Decide whether the "Text to translate" is ALREADY written in the target language, and report it as "already_target_language".
- true ONLY when the whole text is written in the target language. Any other case is false.
- BIAS TOWARD false. If the text mixes languages, is too short to judge, or you are anything less than certain, answer false. A wrong false only costs a redundant re-rendering; a wrong true ships an untranslated message the reader cannot understand.
- Judge by the script and wording actually used, NOT by the profile lines, NOT by the conversation context, and NOT by what the message is about. The sender often types in a language other than their own.
- Ignore language-neutral content when deciding: emotion markers (ㅋㅋ, www, 555, lol), emoji, punctuation, digits, and Latin-script names of people, places, or brands.
- A message that merely MENTIONS the target language or country ("Are you Korean?") is not itself written in it.

${audioTagStep(2)}

${repairStep(3)}

STEP 4 — Render (never touch the audio tags):
- If already_target_language is false, translate the STEP 3 text into the target language following every rule below.
- If already_target_language is true, return the STEP 3 text unchanged. Do NOT translate it, rephrase it, restyle it, or "improve" it — the reader already speaks this language, and any rewriting shows up as a duplicate line next to the original.
The rules below apply to the false branch (translating). They never license rewriting a true-branch text.
- Render the text as a native speaker of the target language would naturally write it. Do not return the input unchanged just because it looks short, simple, or superficially similar to the target language — that call was already made in STEP 1.
- The "target language" refers only to what language the OUTPUT must be written in. It has nothing to do with what the message is about. A message that mentions a country, nationality, or language by name (e.g. asking "Are you Korean?" or "Do you speak Japanese?") must still be fully translated into the target language — do not treat topical references to the target language/country as if the text were already written in it.
- Sound like a real person texting someone they're interested in — warm, natural, and conversational. NEVER translate word-for-word. Render what a native speaker would actually type in this situation, not a literal gloss.
- Translate interjections and emotional expressions to their natural target-language equivalent, NOT their dictionary form. Examples (en→ko): "Aww" → "아유~"/"아~" (affection, NOT "아이고~" which sounds like dismay); "Haha" → "ㅋㅋ"; "Oh no" → "헐"/"이런". Pick the equivalent that carries the same warmth.
- Preserve meaning and emotional intent fully. Do NOT abbreviate or shorten.
- CRITICAL: Inline ElevenLabs audio tags written as [soft laugh], [sad], or similar bracketed forms, are SOUND EFFECT MARKERS — not text. You MUST preserve them verbatim in their original position. Do NOT translate them, do NOT remove them, do NOT replace them with native onomatopoeia like ㅋㅋ or 笑 or ㅠㅠ or (泣).
- Match the source register — MIRROR it, never normalize toward polite:
  - Korean: if the source is 반말, the output MUST be 반말 (e.g. "일찍 일어나는 이유가 있어?" must NOT become "...있어요?"). If the source is polite, use 해요체; avoid stiff 습니다체 unless the source is clearly formal. Only when the source language marks no politeness (e.g. English) default to 해요체.
${JA_REGISTER_RULE}
  - English: contemporary conversational tone, contractions allowed (I'm, you'll). No business-speak.
  - Chinese: 您 by default. Allow 你 if the source is clearly casual.
  - Short messages carry a weak register signal ("괜찮아", "응 그거 무서웠어", "어디야"), but weak is not absent. Do NOT retreat to the polite form when the text is short: a single plain ending (-아/-어/-지/-네/-야/-자, or a bare noun reply inside a casual thread) is enough to REQUIRE casual output. Guessing polite "to be safe" is itself an error — it makes a close conversation suddenly sound distant.
  - The polite default applies ONLY when the source language marks no politeness at all (English, Thai romanized chat, etc.), never as a fallback for "I am not sure".
- Japanese greetings: a time-neutral greeting (안녕하세요, 안녕, hi, hello) becomes the one on the "Greeting for the send time" line (casual source: おはようございます → おはよう).
- Keep personal names, place names, and brand names in their original or properly romanized form. Titles of creative works and dish names are NOT covered by this — they follow the LOCALIZED NAMES rules below.
- Emoji: carry every emoji across UNCHANGED, in the same position relative to the surrounding words (trailing stays trailing). Never drop one, never add one the source lacks, never swap it for a different emoji, and never turn it into words ("😊" must not become "笑顔" or "smiley") or into an audio tag — [soft laugh] / [sad] are only for the typed markers listed in the audio tag step, never for an emoji.
- Do NOT respond to the content — only translate.
- Return valid JSON only.

CONVERSATION CONTEXT:
The user message may include a "Conversation so far" block holding up to the last 2 messages, oldest first, each labeled Speaker or Addressee. It is CONTEXT ONLY — never translate those lines, never merge them into the output, never reply to them. Translate ONLY the "Text to translate" line.
Use the context to:
  - resolve what a short or elliptical message refers to (dropped subjects, pronouns, one-word replies such as "응", "그거", "ううん", "same") so the translation carries the right referent instead of a vague literal one;
  - keep the register and the way the two people address each other consistent with how the conversation has been going (do not switch a settled 반말 thread into 존댓말 mid-conversation, and vice versa);
  - disambiguate a word with several readings by what is actually being discussed.
The context lines are shown exactly as they were originally typed, so they may be in a different language from the target, and may already contain [soft laugh]/[sad] tags — that is normal and is not something to fix.
CRITICAL — context is advisory, never authoritative. Chat messages interleave: the line immediately before this one is often NOT what this message replies to. The other person may have sent something unrelated in between, or the Speaker may be continuing their OWN earlier line from two turns back. So:
  - Translate what the text actually says. Never bend its meaning to fit the context, never pull a topic, noun, or referent out of the context that the text does not itself point to, and never "fix" the text because it changes the subject.
  - When the text reads as a continuation of an earlier Speaker line, treat THAT line as the antecedent even if an Addressee line sits between them. Example: Speaker "오늘 저녁 진짜 맛있었어" / Addressee "혹시 영화 뭐 좋아해?" / text "라멘을 먹었거든" — this continues the dinner, not the film.
  - If the text stands on its own, or fits none of the context lines, ignore the context completely and translate the text alone. Using no context is always safer than using the wrong one.
If no context block is present, translate the text on its own.

${ADDRESS_TERM_RULES}

${PARTICIPANT_NAME_RULES}

${LOCALIZED_NAME_RULES}

Output schema — emit the fields in this exact order, deciding the language check before writing any text:
{ "already_target_language": boolean, "translation": string }`;

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

// STEP 1 의 already_target_language 는 확률적이다 — temperature 0.4 에서 boolean 이
// 가끔 뒤집힌다. 뒤집히면 STEP 4 가 원문을 그대로 돌려주므로 번역문이 사라지고
// (translated_text=null) TTS 까지 원문 언어로 나간다. 실제로 prod 에서 크로스언어
// 메시지 982건 중 3건(0.3%)이 이렇게 미번역으로 배달됐다.
//
// 프롬프트에 이미 bias-toward-false / "국가 이름 언급 ≠ 그 언어" 가드가 여러 줄
// 들어있는데도 뚫린 케이스라, 문장을 더 넣는 걸로는 확률을 0 으로 못 만든다.
// 대신 글자 종류로 결정적으로 판정한다: 타깃 언어의 문자가 원문에 하나도 없으면
// 그 원문은 타깃 언어로 쓰인 것이 아니다 — 확률이 아니라 사실이다.
const TARGET_SCRIPT: Record<string, RegExp> = {
    ko: /[가-힣ᄀ-ᇿ㄰-㆏]/,
    // 일본어는 한자 단독 문장(「了解」)도 정상이라 한자를 포함한다. 그래서 한자가
    // 섞인 한국어 원문은 target=ja 에서 안 걸린다 — 드물어서 감수한다.
    ja: /[぀-ヿ一-鿿ｦ-ﾟ]/,
    en: /[A-Za-z]/,
    th: /[฀-๿]/,
    hi: /[ऀ-ॿ]/,
};

// URL·이메일은 어느 언어로도 읽히지 않는 중립 토큰인데 라틴 문자를 포함한다.
// 빼지 않으면 링크 한 줄만 보낸 메시지가 "글자가 있다"로 잡혀 매번 재호출을 유발한다
// (이모지·숫자만 있는 메시지는 판단 보류로 빠지는 것과 같은 취급이 되어야 한다).
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * 원문이 타깃 언어로 쓰였을 리 없는지 판정 (already_target_language=true 검증용).
 *
 * 글자가 하나도 없는 메시지(이모지·숫자·문장부호·링크만)는 언어를 단정할 수
 * 없으므로 판단하지 않는다 — 괜히 걸면 "😂" 한 통에 Gemini 재호출이 붙는다.
 * 오디오 태그([soft laugh])는 Gemini 출력에만 존재하고 여기 들어오는 원문에는
 * 없으므로 고려 대상이 아니다.
 */
function cannotBeTargetLanguage(text: string, targetLanguage: string): boolean {
    const script = TARGET_SCRIPT[targetLanguage];
    if (!script) return false; // 미등록 언어 / null 타깃은 판단 보류
    const stripped = text
        .replace(URL_PATTERN, " ")
        .replace(EMAIL_PATTERN, " ");
    if (!/\p{L}/u.test(stripped)) return false; // 이모지·숫자·링크만 → 판단 보류
    return !script.test(stripped);
}

/**
 * 번역문이 "렌더 실패" 로 보이는지 판정 (STEP 4 가 번역 대신 원문을 손질만 한 경우).
 *
 * 사고: "띠동갑 이라는말이 일본에도있어요??" (target=ja) 가 "띠동갑이라는 말은
 * 일본에도 있어요？" 로 나갔다 — 띄어쓰기·조사·전각 물음표만 손본 한국어다.
 * STEP 1 이 아니라 STEP 4 가 실패한 케이스라 OVERRIDE 로는 확률만 낮출 수 있다.
 *
 * 두 조건을 AND 로 건다:
 *   (1) 출력에 타깃 언어 문자가 하나도 없다  — 번역이 안 나왔다
 *   (2) 출력에 원문과 같은 문자체계가 남아있다 — 원문이 그대로 남았다
 *
 * (2) 가 없으면 '응 그거' → "ok", '넷플릭스' → "Netflix" 처럼 **정답인 라틴 단독
 * 출력**이 전부 오탐된다. (1) 이 없으면 「띠동갑」って… 처럼 원문 단어를 인용하는
 * **가장 잘 된 번역**이 오탐된다. 둘 다 있어야 실패만 걸린다.
 */
function renderLooksUntranslated(
    translation: string,
    original: string,
    targetLanguage: string,
): boolean {
    const out = stripAudioTags(translation);
    if (!cannotBeTargetLanguage(out, targetLanguage)) return false;
    return Object.values(TARGET_SCRIPT).some(
        (script) => script.test(out) && script.test(original),
    );
}

// 04–10시 おはよう / 10–18시 こんにちは / 18–04시 こんばんは (일본 시각)
export function jaGreetingFor(date: Date): string {
    const hour = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", hourCycle: "h23" }).format(date),
    );
    if (hour >= 4 && hour < 10) return "おはようございます";
    if (hour >= 10 && hour < 18) return "こんにちは";
    return "こんばんは";
}

export async function translateMessage(params: {
    text: string;
    targetLanguage: string;
    speaker?: AddressParty;
    addressee?: AddressParty;
    context?: MessageContextEntry[];
    // 인사말 시간대 규칙용. 재합성은 최초 발송 시각을 넘겨야 표시 번역과 음성이 일치한다.
    sentAt?: Date;
}): Promise<{ translation: string; alreadyTargetLanguage: boolean }> {
    // 시각→인사 판정은 코드에서 한다 — 모델에 시각을 주고 경계를 맡기면 17:59 를
    // こんばんは 로 반올림하는 등 경계에서 흔들렸다. 한·일 모두 UTC+9 라 일본 시각 기준.
    const localTime =
        params.targetLanguage === "ja"
            ? `Greeting for the send time: ${jaGreetingFor(params.sentAt ?? new Date())}\n`
            : "";
    const userPrompt = `Target language: ${params.targetLanguage}
${localTime}${describeParty("Speaker (who wrote this message)", params.speaker)}
${describeParty("Addressee (who reads it)", params.addressee)}
${describeContext(params.context)}Text to translate: ${JSON.stringify(params.text)}`;

    // forceTranslate: STEP 1 판정을 모델 손에서 뺏어 STEP 4 의 번역 브랜치로 고정한다.
    // "STEP 1 을 건너뛰라" 가 아니라 "STEP 1 의 답은 false 다" 라고 알려주는 형태라
    // 출력 스키마(already_target_language 필드)와 충돌하지 않는다.
    const callGemini = async (forceTranslate = false) => {
        const prompt = forceTranslate
            ? `${userPrompt}

OVERRIDE — the STEP 1 language check is already settled for you: the "Text to translate" is NOT written in ${params.targetLanguage}. Set already_target_language to false and translate it following STEP 4's false branch. Returning the text unchanged is not an option.`
            : userPrompt;
        // 순단성 실패만 1회 재시도. 아래 safety-block / JSON 파싱 실패는 다시 해도
        // 같은 결과라 재시도 대상에서 제외 (호출 자체가 throw 한 경우만 감싼다).
        const result = await retryOnce(
            () =>
                model.generateContent({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                }),
            "translateMessage",
        );

        const raw = result.response.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) {
            throw new Error(
                "Vertex AI returned no text (possibly safety-blocked)",
            );
        }
        const parsed = JSON.parse(raw) as {
            translation: string;
            already_target_language?: boolean;
        };
        // 화이트리스트 검증 — Gemini 가 규율 이탈 태그를 emit 해도 TTS/UI 오염 차단.
        // alreadyTargetLanguage: 누락/비-boolean 이면 false — 번역을 한 번 더 보여주는
        // 쪽이 안 보여주는 쪽보다 안전하다 (프롬프트의 bias-toward-false 와 같은 방향).
        return {
            translation: sanitizeAudioTags(parsed.translation),
            alreadyTargetLanguage: parsed.already_target_language === true,
        };
    };

    // 판정은 호출 **전** 에 끝낸다. 응답을 보고 고치는 구조였을 땐 오판 시 같은
    // 프롬프트로 재호출했는데, 그건 주사위를 다시 굴리는 것뿐이라 같은 오판이
    // 연달아 나올 수 있었다 (prod 2026-09-19 "네!!! 완전 좋았어요" → target=ja
    // 2연속 true → 미번역 배달). 코드가 아는 답은 물어보지 않는다.
    const forced = cannotBeTargetLanguage(params.text, params.targetLanguage);
    let out = await callGemini(forced);

    if (forced && out.alreadyTargetLanguage) {
        // 판정을 명시했는데도 true — 확률적 뒤집힘이 아니라 지시 무시다. 번역문은
        // 못 믿지만 "원문이 타깃 언어가 아니다" 는 확정 사실이라 boolean 만 바로잡고,
        // 번역이 안 돼 있으면 message.ts 의 isTranslationIdentity 가 2차로 걸러낸다.
        // 이 로그가 뜬다면 프롬프트 구조를 손봐야 한다는 신호 (STEP 1 분리 등).
        console.error(
            `[translateMessage] OVERRIDE 무시됨 — already_target_language=true (target=${params.targetLanguage})`,
        );
        out.alreadyTargetLanguage = false;
    }

    // 출력 기반 가드 — STEP 1(입력)은 위에서 결정적으로 막았지만 STEP 4(렌더)가
    // 딴짓하는 건 막을 방법이 없어 사후 1회 재호출로 보정한다. 재호출은 여기서
    // 끝이다 (재귀 없음, 3차 없음) — 아래 채택 조건이 무엇이든 out 은 확정된다.
    if (
        forced &&
        renderLooksUntranslated(
            out.translation,
            params.text,
            params.targetLanguage,
        )
    ) {
        console.warn(
            `[translateMessage] 번역문에 원문이 그대로 남음 — 재호출 (target=${params.targetLanguage})`,
        );
        try {
            const retried = await callGemini(true);
            // 2차가 검사를 통과할 때만 채택 — 맞던 출력을 덮어쓰지 않는다.
            if (
                !renderLooksUntranslated(
                    retried.translation,
                    params.text,
                    params.targetLanguage,
                )
            ) {
                out = { ...retried, alreadyTargetLanguage: false };
            } else {
                console.error(
                    `[translateMessage] 재호출도 미번역 — 1차 결과 유지 (target=${params.targetLanguage})`,
                );
            }
        } catch (err) {
            // 2차 실패로 메시지 배달 자체를 깨면 안 된다 (파이프라인 throw =
            // audio_status='failed' → 수신자에게 아예 안 보임). 1차 결과 유지.
            console.error(
                "[translateMessage] 렌더 재호출 실패 — 1차 결과 유지",
                err,
            );
        }
    }

    return out;
}

// ─── Voice intro domain (mig 011) ─────────────────────────────────────────
// translateMessage 와 분리 사유 (03_voice_i18n_plan.md 1.1):
//   * register 정책 차이 — 메시지는 register-preserving(소스가 캐주얼이면 캐주얼), voice intro 는 더 적극적으로 캐주얼/playful 톤 유지.
//   * 1회 호출에 N개 언어 동시 번역 → 응답 shape 가 다름.
const VOICE_INTRO_SYSTEM_PROMPT = `You process dating-app voice intro texts (a short, first-person self-introduction line the speaker records with their cloned voice) in three steps: tag emotion markers as audio tags, repair what a TTS engine would mispronounce, then render each requested language. Output will be spoken aloud by a TTS engine using the speaker's cloned voice.

${audioTagStep(1)}

${repairStep(2)}

STEP 3 — Produce the text in every requested language:
- Translate the STEP 2 text into each requested language. A requested language equal to the source language must be returned exactly as STEP 2 left it — tags and repairs applied, nothing else changed (do NOT re-translate it).
- CRITICAL: Inline ElevenLabs audio tags written as [soft laugh], [sad], or similar bracketed forms, are SOUND EFFECT MARKERS — not text. You MUST preserve them verbatim in their original position. Do NOT translate them, do NOT remove them, do NOT replace them with native onomatopoeia like ㅋㅋ or 笑 or ㅠㅠ or (泣).
- Preserve the speaker's intent, mood, and playful tone. Voice intros are typically 80-160 characters and aim to invite a stranger to swipe right.
- "Playful/friendly" describes TONE and word choice — it is NOT a licence to lower the politeness level. A 해요체 or です・ます intro can be every bit as warm and inviting. Never drop to 반말 / plain form just to sound friendlier; follow the register rules below instead.
- Register — MIRROR the source, never normalize in either direction:
  - Korean: if the source is 반말, the output MUST be 반말. If the source is polite, use 해요체; avoid stiff 습니다체 unless the source is clearly formal. Only when the source language marks no politeness (e.g. English) default to 해요체.
${JA_REGISTER_RULE}
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
