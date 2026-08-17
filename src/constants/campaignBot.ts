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
// 공범 가능성 = 유저 관심사와의 겹침 개수로 ACCOMPLICE_PCT 조회 (0~10개 → 0~95%).
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
// 유저에게는 확률표를 노출하지 않는다.
export const LICENSES: {
  weight: number;
  display: Record<BotLocale, string>;
  tts: Record<BotLocale, string>;
}[] = [
  {
    weight: 15,
    display: { ko: '술 자격증', ja: 'お酒の資格', en: 'Drinking License' },
    tts: { ko: '술 자격증', ja: 'おさけの資格', en: 'the Drinking License' },
  },
  {
    weight: 15,
    display: { ko: '슈퍼 아르바이터', ja: 'スーパーアルバイター', en: 'Super Part-Timer License' },
    tts: { ko: '슈퍼 아르바이터', ja: 'スーパーアルバイター', en: 'the Super Part-Timer License' },
  },
  {
    weight: 2,
    display: { ko: '풀뽑기 검정 1급', ja: '草むしり検定 1級', en: 'Weed-Pulling Exam, Grade 1' },
    tts: { ko: '풀뽑기 검정 일급', ja: '草むしり検定いっきゅう', en: 'Weed-Pulling Exam Grade One' },
  },
  {
    weight: 15,
    display: { ko: '풀뽑기 검정 2급', ja: '草むしり検定 2級', en: 'Weed-Pulling Exam, Grade 2' },
    tts: { ko: '풀뽑기 검정 이급', ja: '草むしり検定にきゅう', en: 'Weed-Pulling Exam Grade Two' },
  },
  {
    weight: 28,
    display: { ko: '풀뽑기 검정 3급', ja: '草むしり検定 3級', en: 'Weed-Pulling Exam, Grade 3' },
    tts: { ko: '풀뽑기 검정 삼급', ja: '草むしり検定さんきゅう', en: 'Weed-Pulling Exam Grade Three' },
  },
  {
    weight: 10,
    display: { ko: '풀뽑기 검정 4급', ja: '草むしり検定 4級', en: 'Weed-Pulling Exam, Grade 4' },
    tts: { ko: '풀뽑기 검정 사급', ja: '草むしり検定よんきゅう', en: 'Weed-Pulling Exam Grade Four' },
  },
  {
    weight: 15,
    display: { ko: '풀뽑기 검정 5급', ja: '草むしり検定 5級', en: 'Weed-Pulling Exam, Grade 5' },
    tts: { ko: '풀뽑기 검정 오급', ja: '草むしり検定ごきゅう', en: 'Weed-Pulling Exam Grade Five' },
  },
];

// ── 칭호 = 형용사(해시) + 명사(관심사가 가장 많이 몰린 섹션) ──────────
export const TITLE_ADJECTIVES: Record<BotLocale, string>[] = [
  // 하치와레의 시그니처 대사 「なんとかなれ！」 파생 — 일반 형용사로 옮기면
  // 원작 고증이 날아간다.
  { ko: '어떻게든 돼라 식의', ja: 'なんとかなれ系の', en: 'Happy-Go-Lucky' },
  { ko: '뭔가 작고 귀여운', ja: 'なんか小さくてかわいい', en: 'Something Small and Cute' },
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
/** 겹침 0~10개 → 공범 가능성. 인덱스 = 겹침 개수. */
export const ACCOMPLICE_PCT = [0, 10, 20, 28, 38, 48, 57, 67, 76, 86, 95];

/** ACCOMPLICE_PCT 와 인덱스 1:1. 숫자를 TTS 가 틀리게 읽지 않도록 풀어쓴다. */
export const ACCOMPLICE_PCT_TTS: Record<BotLocale, string>[] = [
  { ko: '영 퍼센트', ja: 'ゼロパーセント', en: 'zero percent' },
  { ko: '십 퍼센트', ja: 'じゅっパーセント', en: 'ten percent' },
  { ko: '이십 퍼센트', ja: 'にじゅっパーセント', en: 'twenty percent' },
  { ko: '이십팔 퍼센트', ja: 'にじゅうはちパーセント', en: 'twenty-eight percent' },
  { ko: '삼십팔 퍼센트', ja: 'さんじゅうはちパーセント', en: 'thirty-eight percent' },
  { ko: '사십팔 퍼센트', ja: 'よんじゅうはちパーセント', en: 'forty-eight percent' },
  { ko: '오십칠 퍼센트', ja: 'ごじゅうななパーセント', en: 'fifty-seven percent' },
  { ko: '육십칠 퍼센트', ja: 'ろくじゅうななパーセント', en: 'sixty-seven percent' },
  { ko: '칠십육 퍼센트', ja: 'ななじゅうろくパーセント', en: 'seventy-six percent' },
  { ko: '팔십육 퍼센트', ja: 'はちじゅうろくパーセント', en: 'eighty-six percent' },
  { ko: '구십오 퍼센트', ja: 'きゅうじゅうごパーセント', en: 'ninety-five percent' },
];

/** 겹침 0 / 1~3 / 4~7 / 8~10 네 구간. 위에서부터 먼저 맞는 구간이 선택된다. */
export const ACCOMPLICE_NOTES: {
  minOverlap: number;
  text: Record<BotLocale, string>;
}[] = [
  {
    minOverlap: 8,
    text: {
      ko: '우리 영혼의 단짝인가봐!',
      ja: 'ボクたち、ソウルメイトなのかも！',
      en: 'I think we might be soulmates!',
    },
  },
  {
    minOverlap: 4,
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
I'm Hachiware. I'm wanted for Unauthorized Busking...

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

  en: (v) => `Wah! You found me! I'm Hachiware. I'm wanted for Unauthorized Busking.
Whoever catches me has to file a report with Armor-san. I'll fill it out for you!
Finder, ${v.name}. Qualification, ${v.licenseTts}. Title, ${v.title}.
Accomplice probability, ${v.pctTts}. ${v.note}
There, done! Please hand it in for me. Sorry, I've gotta run again!
Now go find someone real on haru.`,
};

// ── 메시지 2: 응모 안내 (TTS 안 함) ─────────────────────────────────
// 참여 방법(팔로우·해시태그·멘션)은 여기 적지 않고 X 이벤트 게시글에만 둔다 —
// 규칙이 바뀔 때마다 앱 배포가 필요해지는 걸 피하고, 말풍선은 링크 하나로 짧게.
// 링크는 마지막 줄에 단독으로 둔다 (FE 가 URL 만 잘라 탭 가능하게 렌더한다).
// 링크 env(CAMPAIGN_POST_URL_*)가 비어 있으면 안내 줄 자체를 생략한다.
export const ENTRY_GUIDE: Record<BotLocale, (link: string) => string> = {
  ko: (link) =>
    `이 화면을 캡처해서 X에 올리면 선물이 있대!${
      link ? `\n참여 방법은 여기서 확인해줘\n${link}` : ''
    }`,

  ja: (link) =>
    `この画面のスクショをXに投稿するとプレゼントがあるんだって！${
      link ? `\n参加方法はこちらでチェックしてね\n${link}` : ''
    }`,

  en: (link) =>
    `Post a screenshot of this screen on X and there are prizes!${
      link ? `\nCheck how to join here\n${link}` : ''
    }`,
};
