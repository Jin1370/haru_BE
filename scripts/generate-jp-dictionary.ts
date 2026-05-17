// message-moderation-v1 (PR1) — 일본어 모더레이션 사전 생성 스크립트.
//
// 사용법:
//   npx tsx scripts/generate-jp-dictionary.ts
//   npx tsx scripts/generate-jp-dictionary.ts > tmp/ja-candidates.json
//
// 동작:
//   1. `src/constants/moderationDictionary.ts` 의 KO_DICTIONARY_SOURCE 를 input 으로 사용.
//   2. 카테고리별 Gemini 2.5 Flash 호출 — system prompt 에 self_harm 1인칭 제외 룰 명시.
//   3. JSON 만 stdout 으로 출력 — { "sexual": [...], "drug": [...], "minor": [...], "self_harm": [...] }
//   4. stderr 에 "*** HUMAN REVIEW REQUIRED ***" 경고 print — 자동 commit ❌.
//   5. 사용자가 stdout 결과를 검수 → moderationDictionary.ts 의 JA_* 상수에 직접 paste.
//
// **자동 commit 금지** — 본 스크립트는 산출만 한다. 검수는 architect/사용자 책임.
//
// 비용/지연: 4 카테고리 × ~30 토큰 = 4 호출. gemini-2.5-flash 단가 무시 가능.

import { VertexAI, HarmCategory, HarmBlockThreshold } from "@google-cloud/vertexai";
import { env } from "../src/config/env";
import { KO_DICTIONARY_SOURCE } from "../src/constants/moderationDictionary";

const vertexAi = new VertexAI({
    project: env.vertexAi.projectId,
    location: env.vertexAi.location,
});

const SYSTEM_PROMPT = `You are localizing a content moderation dictionary for a Korean-Japanese dating app called "haru".

Given a list of Korean tokens (one of: explicit sexual / drug / minor-related / self-harm command terms) that should be blocked from outgoing messages, produce the equivalent Japanese tokens that should also be blocked.

Rules:
- Output the most common Japanese forms (kanji + hiragana + katakana variants where both are in real-world use).
- Include common slang and 隠語 (e.g., シャブ, ブツ, ヤク, JK, 援助交際) — not just dictionary terms.
- Each token MUST be at least 3 characters (avoid single-kanji false positives — e.g., '麻' alone, '薬' alone). Multi-character compound or katakana-only tokens are safer.
- Do NOT include tokens that have common non-moderation meanings (e.g., '大学' alone, '学校' alone, '先生' alone).
- For self_harm category: ONLY include commands directed at OTHERS ('死ね', '首を吊れ', '消えろ死ね'). NEVER include first-person crisis signals ('死にたい', '消えたい', 'つらい') — those route to crisis support, not blocking. If a Korean token is first-person crisis, OUTPUT AN EMPTY ARRAY for that category.
- Avoid duplicates.
- Output a JSON array of strings — no commentary, no markdown.

Output schema:
["token1", "token2", ...]`;

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
    safetySettings: [
        // self_harm/sexual 카테고리는 BLOCK_ONLY_HIGH 로 두지 않으면 모델이 응답 자체를 거부할 수 있다.
        // 본 스크립트는 모더레이션 사전 생성 목적이므로 임시로 BLOCK_NONE.
        // 출력은 단어 list 이고 사람이 검수 후 commit.
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
});

type Category = "sexual" | "drug" | "minor" | "self_harm";

async function translateCategory(category: Category, koTokens: readonly string[]): Promise<string[]> {
    if (koTokens.length === 0) return [];
    const userPrompt = `Category: ${category}
Korean tokens to localize into Japanese moderation tokens:
${JSON.stringify(koTokens, null, 2)}

Output a JSON array of Japanese tokens following the rules in the system prompt.`;

    const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    });

    const raw = result.response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
        process.stderr.write(`[WARN] category=${category} returned no text (possibly safety-blocked)\n`);
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            process.stderr.write(`[WARN] category=${category} returned non-array JSON\n`);
            return [];
        }
        return parsed.filter((x): x is string => typeof x === "string" && x.length >= 2);
    } catch (e) {
        process.stderr.write(`[WARN] category=${category} JSON parse failed: ${(e as Error).message}\n`);
        process.stderr.write(`[WARN] raw output: ${raw}\n`);
        return [];
    }
}

async function main() {
    process.stderr.write("*** generating Japanese moderation dictionary candidates ***\n");
    process.stderr.write("input: src/constants/moderationDictionary.ts (KO slots)\n\n");

    const out: Record<Category, string[]> = {
        sexual: [],
        drug: [],
        minor: [],
        self_harm: [],
    };

    for (const category of ["sexual", "drug", "minor", "self_harm"] as const) {
        process.stderr.write(`-> translating category: ${category} (${KO_DICTIONARY_SOURCE[category].length} ko tokens)\n`);
        out[category] = await translateCategory(category, KO_DICTIONARY_SOURCE[category]);
        process.stderr.write(`   <- ${out[category].length} ja candidates\n`);
    }

    // 사람 검수 강제 경고 — stderr 에만 (stdout 은 pure JSON 으로 유지).
    process.stderr.write("\n***********************************************************\n");
    process.stderr.write("*** HUMAN REVIEW REQUIRED                                ***\n");
    process.stderr.write("*** Do NOT commit ja slots without reviewing each token  ***\n");
    process.stderr.write("*** for false positives in common Japanese usage.        ***\n");
    process.stderr.write("*** Especially:                                          ***\n");
    process.stderr.write("***   - self_harm: only 2nd/3rd-person commands          ***\n");
    process.stderr.write("***   - drug:      no common compound nouns (e.g. 大学)  ***\n");
    process.stderr.write("***   - minor:     no generic school-age terms alone     ***\n");
    process.stderr.write("***   - sexual:    no everyday emotion words (好き etc)  ***\n");
    process.stderr.write("***********************************************************\n\n");

    // stdout 은 JSON 만 — 사용자가 `> tmp/ja.json` 으로 redirect 가능.
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((err) => {
    process.stderr.write(`[FATAL] ${(err as Error).message}\n`);
    process.exit(1);
});
