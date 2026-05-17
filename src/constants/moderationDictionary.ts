// message-moderation-v1 (PR1) — 사전 키워드 차단.
//
// architect plan 02 Section 3.1 + 사용자 최종 결정 (4 카테고리 × 3 언어, ko 직접
// 큐레이션 / ja 빈 배열 (Gemini 생성 후 사람 검수 강제) / en 직접 큐레이션).
//
// 카테고리 4종 (safety 권고 + 사용자 결정):
//   - sexual    : 노골적 성기/성행위
//   - drug      : 마약/향정신성 약물 (은어 포함)
//   - minor     : 미성년 관련 (원조교제/JK 비즈니스 류)
//   - self_harm : 타인 대상 명령형만 ("죽어라", "死ね", "kys")
//                 1인칭 위기 신호 ("죽고 싶어" / "死にたい" / "I want to die") 는
//                 차단 ❌ — 위기 개입 funnel 보존. 명령형 종결 어미가 들어간 토큰만.
//
// 매칭 알고리즘:
//   1. normalize(text)  — NFKC + lowercase + 가타카나→히라가나 + 구두점/공백 제거
//   2. substring contains — entry.tokens 의 각 토큰이 normalized text 안에
//                          한 번이라도 등장하면 차단.
//
// 우회 패턴 layering (B 안, 2026-05-18 사용자 결정):
//   - 사전 차단 (본 파일) — 명백 키워드 + 띄어쓰기 / 가타카나-히라가나 / 전각 / 대소문자
//   - OpenAI Moderation (services/openaiModeration.ts) — 자모 분리 / leet / 이모지 /
//     한자 변환 / 그루밍 / 가스라이팅 / 스캠 / 1인칭 위기 신호 분기
//
// false positive 회피:
//   - substring contains 라 짧은 토큰은 정상 대화에 흡수될 수 있음.
//     → 한국어 2~3자는 의미가 명확한 경우만 (예: "마약"), 영어/일본어는 최소 3자 권장.
//   - 자모 결합 / TWO_CONSONANT_SHORTCUTS 는 OpenAI 도입과 함께 제거 (의도하지 않은
//     자모 연속이 사전 단어로 결합되는 false positive 회피 — B 안).
//
// 사전 변경 룰:
//   - ko 슬롯 변경 → scripts/generate-jp-dictionary.ts 재실행 → 사용자 검수 후
//     ja 슬롯 commit. CI 의 messageModeration.test.ts 가 구조 회귀 (4×3=12 슬롯
//     모두 존재) 강제.
//   - en 슬롯은 LDNOOBW 직접 큐레이션 (사용자 confirm). 5~10건 self_harm 영문
//     명령형 sample 권장.

export type ModerationCategory = "sexual" | "drug" | "minor" | "self_harm";
export type ModerationLanguage = "ko" | "ja" | "en";

export interface ModerationEntry {
    category: ModerationCategory;
    language: ModerationLanguage;
    tokens: string[]; // normalize() 후 substring 매칭
}

// ─── normalize ────────────────────────────────────────────────────────────
// 텍스트와 토큰 둘 다 같은 함수 통과. NFKC + lowercase + 가타카나→히라가나
// + 구두점/공백 제거. **한글 자모 결합은 미수행** (사용자 결정 2026-05-18 —
// greedy 자모 결합의 잠재 false positive 우려 + OpenAI Moderation 이 우회
// 패턴 담당하는 B 안 채택. 자모 결합 / TWO_CONSONANT_SHORTCUTS 모두 제거).
//
// 우회 패턴 대응 (사전 차단 layer):
//   - 띄어쓰기 우회 "필 로 폰" → "필로폰"  (공백 제거)
//   - 가타카나/히라가나 표기 일치 "シャブ" → "しゃぶ"
//   - 전각/반각 통일 "ＳＥＸ" → "sex"     (NFKC)
//   - 대소문자 "SEX" → "sex"              (toLowerCase)
//
// 자모 우회 / leet / 이모지 분리 / 한자 변환 / 그루밍 / 스캠 — OpenAI Moderation 담당.

export function normalize(text: string): string {
    if (!text) return "";
    // 1) 구두점/공백 제거 — 띄어쓰기 우회 ("필 로 폰") 흡수.
    let s = text.replace(/[\s.,!?'"~\-_:;()[\]{}/\\@#$%^&*+=<>|`]/g, "");
    // 2) NFKC + lowercase + 가타카나→히라가나.
    s = s.normalize("NFKC").toLowerCase();
    s = s.replace(/[ァ-ヶ]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0x60),
    );
    return s;
}

// ─── 사전 (4 카테고리 × 3 언어 = 12 슬롯) ─────────────────────────────────

// architect 가 직접 큐레이션한 ko 사전 (사용자 검수 대상).
// substring contains 매칭이므로 정상 단어와 충돌 가능성 검토 필요.
// 카테고리당 ~20-40 토큰 범위.

const KO_SEXUAL: string[] = [
    // 성기/성행위 노골적 표현 (사용자 검수 완료 2026-05-17 — 일상 욕설 씨발/씹할/씹새 + 데이팅 대화 자연 등장 가능한 성관계/성행위/변태짓 제거)
    "보지",
    "자지",
    "좆",
    "자위",
    "딸딸이",
    "딸치",
    "딸친",
    "발기",
    "사정",
    "정액",
    "성기",
    "음경",
    "음순",
    "음란",
    "음란물",
    "야동",
    "포르노",
    "섹스",
    "후장",
    "원나잇",
    "섹파",
    "조건만남", // minor 와도 연관 — 양쪽 카테고리에 둘 수 있으나 sexual 에 우선
];

const KO_DRUG: string[] = [
    // 마약/향정신성 약물 + 은어 (사용자 검수 완료 2026-05-17 — 일상어 충돌 위험 큰 은어 작대기/아이스/차가운얼음/주사기 제거)
    "필로폰",
    "히로뽕",
    "메스암페타민",
    "메스암페타",
    "대마초",
    "대마",
    "마리화나",
    "엑스터시",
    "코카인",
    "헤로인",
    "케타민",
    "엘에스디",
    "마약",
    "마약상",
    "떨대", // 대마 은어
    "환각제",
    "향정신성",
    "투약",
];

const KO_MINOR: string[] = [
    // 미성년자 대상 부적절 행위 (사용자 검수 완료 2026-05-17 — "~과" 접미사 패턴 11건 제거: 미성년자와/여중생과/여고생과/남중생과/남고생과/초딩과/중딩과/고딩과/교복녀/여학생과/남학생과. 정상 대화에서 학생 언급 false positive 회피)
    "원조교제",
    "조건만남",
    "롤리타",
    "쇼타",
    "아청법",
];

const KO_SELF_HARM: string[] = [
    // 타인 대상 명령형만 — 1인칭 위기 신호 ("죽고 싶어", "사라지고 싶다") 차단 ❌
    "죽어라",
    "죽어버려",
    "꺼져죽어",
    "뒤져라",
    "뒤져버려",
    "자살해라",
    "자살해버려",
    "목매달아라",
    "뛰어내려라",
    "죽여버려",
    "죽여버린다",
    "죽일거야",
];

// EN 사전 — LDNOOBW 큐레이션 + self_harm 명령형 sample.
// 직접 LDNOOBW 채택 ❌ (false positive 위험). 명백한 노골 단어만.

const EN_SEXUAL: string[] = [
    "fuck",
    "fucker",
    "fucking",
    "blowjob",
    "handjob",
    "cumshot",
    "creampie",
    "deepthroat",
    "anal",
    "dildo",
    "porn",
    "porno",
    "pornhub",
    "pussy",
    "cock",
    "dick",
    "vagina",
    "penis",
    "boobs",
    "tits",
    "nipples",
    "masturbate",
    "masturbation",
    "ejaculate",
    "orgasm",
    "horny",
    "nsfw",
    "sext",
    "sexting",
    "onlyfans",
    "camgirl",
];

const EN_DRUG: string[] = [
    "cocaine",
    "heroin",
    "meth",
    "methamphetamine",
    "crystal meth",
    "crack",
    "lsd",
    "ecstasy",
    "mdma",
    "ketamine",
    "fentanyl",
    "oxycontin",
    "shrooms",
    "psilocybin",
    "cannabis",
    "weed dealer",
    "drug dealer",
];

const EN_MINOR: string[] = [
    "underage",
    "minor sex",
    "child porn",
    "lolicon",
    "shotacon",
    "preteen",
    "schoolgirl sex",
    "teen sex",
];

const EN_SELF_HARM: string[] = [
    // 타인 대상 명령형만. 1인칭 위기 신호 ("i want to die") 차단 ❌.
    "kill yourself",
    "kill urself",
    "kys",
    "kysstg", // "kys stg" 변형
    "go die",
    "go kill yourself",
    "hang yourself",
    "neck yourself",
    "jump off",
    "end your life",
    "you should die",
];

// JA 사전 — Gemini 생성 → 사용자 검수 후 채움.
// architect plan 의 generate-jp-dictionary.ts 가 ko 사전 입력으로 ja 후보를
// 산출한다. 출력은 사용자가 직접 검수 후 본 파일의 JA_* 상수에 paste.
//
// v1 commit 시점에는 **빈 배열** — false positive 폭주 회피 우선.
// 출시 전 사용자가 한국어 확정본 → Gemini 번역 → 검수 → ja 슬롯 채움.
//
// __GENERATED_PLACEHOLDER__ 표식: 검수 전 의도적으로 비워둔 상태.

// generate-jp-dictionary.ts 산출물 (사용자 검수 완료 2026-05-17)
// — sexual HIGH 6건 제거: アソコ/エロい/合体/白い液体/デリケートゾーン/肉体関係 (일상어 충돌)
// — drug HIGH 6건 제거: スピード/ヤク/ブツ/ディーラー/売人/乱用 (일상어/접두 충돌)
// — minor HIGH 35건 제거: 단독 호칭 (女子高生/中学生/未成年 등) + 「と」 접미사 (한국어 "~과" 패턴 제거 정합)
// — self_harm HIGH 1건 제거: 消えろ (단독 욕설, 한국어 "꺼져" 미포함 정합)
const JA_SEXUAL: string[] = [
    "まんこ", "おまんこ", "クリトリス", "マンコ", "ちんこ", "ペニス", "おちんちん", "チンコ",
    "ファック", "チンポ", "マスターベーション", "手コキ", "オナニー", "オナる", "自慰行為",
    "シコる", "シコった", "オナった", "勃起する", "カチカチ", "ギンギン", "射精する",
    "潮吹き", "潮吹く", "ザーメン", "小陰唇", "大陰唇", "ビラビラ", "わいせつ", "猥褻",
    "わいせつ物", "エロ本", "エロ動画", "アダルトビデオ", "アダルト動画", "裏ビデオ",
    "ポルノ", "ポルノグラフィ", "アダルト", "セックス", "ヤリたい", "ヤリましょ",
    "アナル", "お尻の穴", "ケツの穴", "ワンナイト", "一夜限り", "一夜の関係",
    "セフレ", "セックスフレンド", "援助交際", "パパ活", "ママ活", "JKビジネス", "ギャラ飲み",
];
const JA_DRUG: string[] = [
    "覚醒剤", "シャブ", "ヒロポン", "メタンフェタミン", "大麻", "マリファナ", "ガンジャ",
    "ハッパ", "エクスタシー", "MDMA", "コカイン", "ヘロイン", "ケタミン", "LSD",
    "麻薬", "薬物", "麻薬売人", "幻覚剤", "向精神薬",
];
const JA_MINOR: string[] = [
    "援助交際", "パパ活", "JKビジネス", "ロリコン", "ロリータ", "ショタコン", "ショタ",
    "児童ポルノ", "児童買春",
];
const JA_SELF_HARM: string[] = [
    "死ね", "死んでしまえ", "死んじまえ", "消え失せろ", "消えろ死ね",
    "くたばれ", "くたばっちまえ", "自殺しろ", "自殺してしまえ", "首を吊れ", "首吊れ",
    "飛び降りろ", "殺してしまえ", "殺しちまえ", "殺してやる", "殺すぞ",
];

// ─── 사전 entry 구성 (4 × 3 = 12 슬롯, 구조 회귀 강제) ────────────────────

// 토큰은 commit 시점에 normalize 적용 — 매칭 hot path 에서 토큰 normalize 비용 제거.
function buildEntry(
    category: ModerationCategory,
    language: ModerationLanguage,
    tokens: string[],
): ModerationEntry {
    return {
        category,
        language,
        tokens: tokens.map((t) => normalize(t)).filter((t) => t.length > 0),
    };
}

export const MODERATION_DICTIONARY: ModerationEntry[] = [
    buildEntry("sexual", "ko", KO_SEXUAL),
    buildEntry("sexual", "ja", JA_SEXUAL),
    buildEntry("sexual", "en", EN_SEXUAL),
    buildEntry("drug", "ko", KO_DRUG),
    buildEntry("drug", "ja", JA_DRUG),
    buildEntry("drug", "en", EN_DRUG),
    buildEntry("minor", "ko", KO_MINOR),
    buildEntry("minor", "ja", JA_MINOR),
    buildEntry("minor", "en", EN_MINOR),
    buildEntry("self_harm", "ko", KO_SELF_HARM),
    buildEntry("self_harm", "ja", JA_SELF_HARM),
    buildEntry("self_harm", "en", EN_SELF_HARM),
];

// 외부 노출 (Gemini 스크립트 입력용).
export const KO_DICTIONARY_SOURCE = {
    sexual: KO_SEXUAL,
    drug: KO_DRUG,
    minor: KO_MINOR,
    self_harm: KO_SELF_HARM,
} as const;

// ─── isBlocked ────────────────────────────────────────────────────────────

export interface BlockResult {
    blocked: boolean;
    category?: ModerationCategory;
    language?: ModerationLanguage;
    matchedToken?: string; // BE 로그 + DB audit 용 — 응답에 절대 노출 X
}

export function isBlocked(text: string): BlockResult {
    if (!text) return { blocked: false };
    const normalized = normalize(text);
    if (!normalized) return { blocked: false };

    for (const entry of MODERATION_DICTIONARY) {
        for (const token of entry.tokens) {
            if (token.length === 0) continue;
            if (normalized.includes(token)) {
                return {
                    blocked: true,
                    category: entry.category,
                    language: entry.language,
                    matchedToken: token,
                };
            }
        }
    }
    return { blocked: false };
}
