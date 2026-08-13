// 캠페인 봇(하치와레 발견 이벤트) 의 카피·판정 테이블.
//
// 표시 텍스트와 TTS 입력 텍스트를 분리한다 (voice intro 의 replaceTagsForDisplay
// / prepareTextForTTS 와 같은 사상). 카드의 `▼`·`「」`·`%` 는 읽히면 음성이
// 망가지고, 숫자는 카운터가 붙으면 TTS 가 읽는 법을 자주 틀리기 때문에 유한
// 집합(급수 1~5, 퍼센트 11단계)만 미리 풀어쓴 문자열로 둔다. 발견 번호는 값이
// 무한하므로 TTS 에서는 생략하고 화면에만 노출한다.

export type BotLocale = 'ko' | 'ja' | 'en';

/** profiles.language 는 th/hi 도 가질 수 있다 (mig 042 국적 파생). 카피는 3벌뿐. */
export function toBotLocale(language: string | null | undefined): BotLocale {
  return language === 'ko' || language === 'ja' || language === 'en' ? language : 'en';
}

// ── 하치와레 관심사 ────────────────────────────────────────────────
// 공범 가능성 = 유저 관심사와의 겹침 개수 × 8 (0~10개 → 0~80%).
// 봇 프로필의 실제 profiles.interests 와 같은 값이어야 한다. DB 를 매번 읽지 않는
// 이유: 봇 프로필이 손상돼도 캠페인 판정이 흔들리지 않게 하기 위함.
export const BOT_INTERESTS = [
  'walking',
  'foodie',
  'camping',
  'travel',
  'picnic',
  'cooking',
  'singing',
  'guitar',
  'photography',
  'selfDev',
] as const;

// ── 자격증 (확률 가중, 합계 100) ────────────────────────────────────
// 난이도가 높을수록 희귀. 유저에게는 확률표를 노출하지 않는다.
export const LICENSES: {
  weight: number;
  display: Record<BotLocale, string>;
  tts: Record<BotLocale, string>;
}[] = [
  {
    weight: 7,
    display: { ko: '조주 자격증', ja: 'お酒の資格', en: 'Liquor License' },
    tts: { ko: '조주 자격증', ja: 'おさけの資格', en: 'the Liquor License' },
  },
  {
    weight: 7,
    display: { ko: '슈퍼 알바이터', ja: 'スーパーアルバイター', en: 'Super Part-Timer' },
    tts: { ko: '슈퍼 알바이터', ja: 'スーパーアルバイター', en: 'Super Part-Timer' },
  },
  {
    weight: 10,
    display: { ko: '풀뽑기 검정 1급', ja: '草むしり検定 1級', en: 'Weed-Pulling Exam, Grade 1' },
    tts: { ko: '풀뽑기 검정 일급', ja: '草むしり検定いっきゅう', en: 'Weed-Pulling Exam Grade One' },
  },
  {
    weight: 20,
    display: { ko: '풀뽑기 검정 2급', ja: '草むしり検定 2級', en: 'Weed-Pulling Exam, Grade 2' },
    tts: { ko: '풀뽑기 검정 이급', ja: '草むしり検定にきゅう', en: 'Weed-Pulling Exam Grade Two' },
  },
  {
    weight: 26,
    display: { ko: '풀뽑기 검정 3급', ja: '草むしり検定 3級', en: 'Weed-Pulling Exam, Grade 3' },
    tts: { ko: '풀뽑기 검정 삼급', ja: '草むしり検定さんきゅう', en: 'Weed-Pulling Exam Grade Three' },
  },
  {
    weight: 10,
    display: { ko: '풀뽑기 검정 4급', ja: '草むしり検定 4級', en: 'Weed-Pulling Exam, Grade 4' },
    tts: { ko: '풀뽑기 검정 사급', ja: '草むしり検定よんきゅう', en: 'Weed-Pulling Exam Grade Four' },
  },
  {
    weight: 20,
    display: { ko: '풀뽑기 검정 5급', ja: '草むしり検定 5級', en: 'Weed-Pulling Exam, Grade 5' },
    tts: { ko: '풀뽑기 검정 오급', ja: '草むしり検定ごきゅう', en: 'Weed-Pulling Exam Grade Five' },
  },
];

// ── 칭호 = 형용사(해시) + 명사(관심사가 가장 많이 몰린 섹션) ──────────
export const TITLE_ADJECTIVES: Record<BotLocale, string>[] = [
  { ko: '낙천적인', ja: 'なんとかなれ系の', en: 'Happy-Go-Lucky' },
  { ko: '뭔가 작고 귀여운', ja: 'なんか小さくてかわいい', en: 'Somehow Small and Cute' },
  { ko: '멋진', ja: 'カッコイイ', en: 'Cool' },
  { ko: '잘 웃는', ja: 'よく笑う', en: 'Always-Laughing' },
  { ko: '노력파인', ja: 'がんばりやの', en: 'Hardworking' },
  { ko: '상냥한', ja: 'やさしい', en: 'Kindhearted' },
  { ko: '최고의', ja: 'サイコーな', en: 'Greatest' },
  { ko: '신기한', ja: 'ふしぎな', en: 'Mysterious' },
  { ko: '매일 즐거운', ja: 'まいにち楽しい', en: 'Always-Having-Fun' },
  { ko: '덜렁대는', ja: 'あわてんぼうな', en: 'Clumsy' },
  { ko: '잠꾸러기', ja: 'ねぼすけな', en: 'Sleepyhead' },
  { ko: '울보인', ja: '泣き虫な', en: 'Crybaby' },
];

export type InterestSection =
  | 'content'
  | 'games'
  | 'outdoor'
  | 'indoor'
  | 'sports'
  | 'music'
  | 'etc';

export const TITLE_NOUNS: Record<InterestSection, Record<BotLocale, string>> = {
  content: { ko: '이야기통', ja: '物語通', en: 'Story Buff' },
  games: { ko: '토벌자', ja: '討伐者', en: 'Subjugator' },
  outdoor: { ko: '탐험가', ja: '探検家', en: 'Explorer' },
  indoor: { ko: '집콕 장인', ja: 'おうち職人', en: 'Homebody Artisan' },
  sports: { ko: '체력 괴물', ja: '体力おばけ', en: 'Stamina Monster' },
  music: { ko: '노래하는 이', ja: '歌い手', en: 'Singer' },
  etc: { ko: '취향 확고한 사람', ja: 'こだわり屋', en: 'Connoisseur' },
};

// haru_FE/src/constants/interests.ts 의 섹션 구성 사본. FE 에 관심사가 추가되면
// 여기 없는 id 는 'etc' 로 떨어진다 (칭호 명사만 영향, 공범 가능성은 무관).
export const SECTION_INTEREST_IDS: Record<InterestSection, string[]> = {
  content: ['drama', 'movies', 'anime', 'youtube', 'webtoon', 'variety', 'documentary', 'thriller', 'romance', 'scifi'],
  games: ['gaming', 'lol', 'overwatch', 'valorant', 'pubg', 'minecraft', 'roblox', 'genshin', 'mobileGame', 'nintendo', 'playstation', 'rpg', 'fps', 'simulation'],
  outdoor: ['cafe', 'walking', 'foodie', 'escapeRoom', 'bar', 'camping', 'travel', 'shopping', 'driving', 'picnic', 'karaoke', 'cinema', 'concert', 'exhibition', 'festival'],
  indoor: ['reading', 'cooking', 'baking', 'drawing', 'bingeWatch', 'boardGame', 'homeCafe', 'gardening', 'writing', 'puzzle', 'homeWorkout', 'knitting', 'candleMaking', 'diy', 'teaCeremony'],
  sports: ['gym', 'yoga', 'pilates', 'running', 'cycling', 'hiking', 'swimming', 'climbing', 'basketball', 'soccer', 'tennis', 'badminton', 'bowling', 'golf', 'dance'],
  music: ['music', 'kpop', 'jpop', 'pop', 'hiphop', 'ballad', 'indie', 'rock', 'rnb', 'jazz', 'guitar', 'piano', 'ukulele', 'drums', 'bass', 'violin', 'composing', 'singing'],
  etc: ['photography', 'pets', 'wine', 'coffee', 'meditation', 'selfDev', 'languageLearn', 'fashion', 'beauty', 'tattoo', 'cosplay', 'perfume', 'mbti', 'astrology', 'tarot'],
};

// ── 공범 가능성 ────────────────────────────────────────────────────
/** 겹침 0~10개 → 0~80%. 8% 씩. */
export const ACCOMPLICE_PCT_TTS: Record<BotLocale, string>[] = [
  { ko: '영 퍼센트', ja: 'ゼロパーセント', en: 'zero percent' },
  { ko: '팔 퍼센트', ja: 'はちパーセント', en: 'eight percent' },
  { ko: '십육 퍼센트', ja: 'じゅうろくパーセント', en: 'sixteen percent' },
  { ko: '이십사 퍼센트', ja: 'にじゅうよんパーセント', en: 'twenty-four percent' },
  { ko: '삼십이 퍼센트', ja: 'さんじゅうにパーセント', en: 'thirty-two percent' },
  { ko: '사십 퍼센트', ja: 'よんじゅうパーセント', en: 'forty percent' },
  { ko: '사십팔 퍼센트', ja: 'よんじゅうはちパーセント', en: 'forty-eight percent' },
  { ko: '오십육 퍼센트', ja: 'ごじゅうろくパーセント', en: 'fifty-six percent' },
  { ko: '육십사 퍼센트', ja: 'ろくじゅうよんパーセント', en: 'sixty-four percent' },
  { ko: '칠십이 퍼센트', ja: 'ななじゅうにパーセント', en: 'seventy-two percent' },
  { ko: '팔십 퍼센트', ja: 'はちじゅうパーセント', en: 'eighty percent' },
];

/** 겹침 0 / 1~4 / 5~10 세 구간. */
export const ACCOMPLICE_NOTES: {
  minOverlap: number;
  text: Record<BotLocale, string>;
}[] = [
  {
    minOverlap: 5,
    text: {
      ko: '관심사가 이렇게 비슷하다니…!',
      ja: 'こんなに趣味が似てるなんて…！',
      en: 'Our interests are THIS similar...!',
    },
  },
  {
    minOverlap: 1,
    text: {
      ko: '관심사가 좀 비슷한데…?',
      ja: 'ちょっと趣味が似てるような…？',
      en: 'Our interests are kinda similar...?',
    },
  },
  {
    minOverlap: 0,
    text: {
      ko: '증거가 하나도 없네! 너는 무죄야~',
      ja: '証拠なし！ キミは無実だ〜',
      en: 'No evidence at all! You are innocent~',
    },
  },
];

// ── 메시지 1: 진단 카드 (TTS 함) ────────────────────────────────────
export interface CardVars {
  name: string;
  rank: number;
  license: string;
  title: string;
  pct: number;
  note: string;
}

export const CARD_DISPLAY: Record<BotLocale, (v: CardVars) => string> = {
  ko: (v) => `우와! 들켜버렸다…!
나, 하치와레. 무허가 버스킹죄로 지명수배 중이었거든…

나를 잡은 사람은 갑옷 씨한테 서류를 내야 한대.
내가 써둘게!

▼ 발견자
${v.name} (${v.rank}번째)
▼ 자격
${v.license}
▼ 칭호
${v.title}
▼ 공범 가능성
${v.pct}% (${v.note})

자, 완료! 제출은 부탁할게.
미안, 나는 다시 도망갈래!
너도 haru에서 진짜 누군가를 찾아봐.`,

  ja: (v) => `わァ！ 見つかっちゃった…！
ボク、ハチワレ。無許可路上ライブ罪で指名手配されてたんだ…

つかまえた人は、鎧さんに書類を出さなきゃなんだって。
ボクが書いとくね！

▼ 発見者
${v.name}（${v.rank}人目）
▼ 資格
${v.license}
▼ 称号
${v.title}
▼ 共犯の可能性
${v.pct}％（${v.note}）

はい、完了！ 提出はおねがい。
ごめん、ボクはまた逃げるね！
キミも haru で、ホンモノの誰かを見つけて。`,

  en: (v) => `Wah! You found me...!
I'm Hachiware. I've been wanted for Unauthorized Street Performance...

Whoever catches me has to file a report with Armor-san.
I'll fill it out for you!

▼ Finder
${v.name} (#${v.rank})
▼ Qualification
${v.license}
▼ Title
${v.title}
▼ Accomplice Probability
${v.pct}% (${v.note})

There, done! Please hand it in for me.
Sorry, I've gotta run again!
Now go find someone real on haru.`,
};

/** TTS 입력. `▼`·괄호·기호 제거, 숫자는 풀어쓴 문자열, 발견 번호는 생략. */
export const CARD_TTS: Record<
  BotLocale,
  (v: { name: string; licenseTts: string; title: string; pctTts: string; note: string }) => string
> = {
  ko: (v) => `우와! 들켜버렸다…! 나, 하치와레. 무허가 버스킹죄로 지명수배 중이었거든…
나를 잡은 사람은 갑옷 씨한테 서류를 내야 한대. 내가 써둘게!
발견자, ${v.name}. 자격은 ${v.licenseTts}. 칭호는 ${v.title}.
공범 가능성은 ${v.pctTts}. ${v.note}
자, 완료! 제출은 부탁할게. 미안, 나는 다시 도망갈래!
너도 하루에서 진짜 누군가를 찾아봐.`,

  ja: (v) => `わァ！ 見つかっちゃった…！ ボク、ハチワレ。無許可路上ライブ罪で指名手配されてたんだ…
つかまえた人は、鎧さんに書類を出さなきゃなんだって。ボクが書いとくね！
発見者、${v.name}。資格は${v.licenseTts}。称号は${v.title}。
共犯の可能性は${v.pctTts}。${v.note}
はい、完了！ 提出はおねがい。ごめん、ボクはまた逃げるね！
キミも ハル で、ホンモノの誰かを見つけて。`,

  en: (v) => `Wah! You found me! I'm Hachiware. I've been wanted for Unauthorized Street Performance.
Whoever catches me has to file a report with Armor-san. I'll fill it out for you!
Finder, ${v.name}. Qualification, ${v.licenseTts}. Title, ${v.title}.
Accomplice probability, ${v.pctTts}. ${v.note}
There, done! Please hand it in for me. Sorry, I've gotta run again!
Now go find someone real on haru.`,
};

// ── 메시지 2: 응모 안내 (TTS 안 함) ─────────────────────────────────
// 해시태그와 계정 핸들은 세 로케일 모두 원문 고정 — 번역하면 집계가 갈라진다.
//
// 두 토큰은 반드시 각자의 줄에 단독으로 둔다. 문장 안에 섞으면 말풍선 폭에 따라
// 토큰 중간에서 줄바꿈이 일어나 읽기도 복사하기도 어려워진다. 보이지 않는
// word-joiner(U+2060) 를 끼워 넣는 방법은 쓰지 않는다 — 사용자가 복사할 때 그
// 문자까지 함께 붙여넣어져 X 에서 해시태그/멘션이 인식되지 않을 수 있다.
export const HASHTAG = '#ハチワレ見つけた';
export const X_HANDLE = '@haru_voice_app';

export const ENTRY_GUIDE: Record<BotLocale, (link: string) => string> = {
  ko: (link) => `① X에서 아래 계정 팔로우하기
${X_HANDLE}

② 이 화면 스크린샷을 X에 올리기
글에 아래 두 개를 꼭 넣어줘!
${HASHTAG}
${X_HANDLE}

추첨으로 선물 있어~${link ? `\n\n자세히 보기 → ${link}` : ''}`,

  ja: (link) => `① Xで下のアカウントをフォロー
${X_HANDLE}

② この画面のスクショをXに投稿
投稿に下の2つを必ず入れてね！
${HASHTAG}
${X_HANDLE}

抽選でプレゼントあるよ〜${link ? `\n\nくわしくはこちら → ${link}` : ''}`,

  en: (link) => `① Follow this account on X
${X_HANDLE}

② Post a screenshot of this screen on X
Include both of these in your post!
${HASHTAG}
${X_HANDLE}

Prizes by lottery~${link ? `\n\nDetails → ${link}` : ''}`,
};
