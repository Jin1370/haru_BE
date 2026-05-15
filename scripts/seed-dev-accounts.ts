// 개발 환경용 더미 계정 10명 시드.
//
// 만들어내는 것:
//   * auth.users 10명 (email/password, email_confirm=true, user_metadata.is_dev_seed=true)
//     - 비밀번호는 전원 SEED_PASSWORD('aaaa1111') 로 통일 (dev/QA 편의)
//   * profiles 10건 (ko 5 / ja 5, 5M/5F, voice clone status = ready, 스톡 voice_id)
//     - Test1~Test3: KR/ko/M, Test4~Test5: KR/ko/F
//     - Test6~Test8: JP/ja/F, Test9~Test10: JP/ja/M
//     - voice_intro 텍스트는 'simple-1' phrase 로 전원 통일 (ko/ja 슬롯별)
//     - interests 는 전부 빈 배열 ([])
//   * user_preferences 10건 (크로스언어 매칭 — ko → ja/JP 선호, ja → ko/KR 선호)
//   * photos 버킷에 기본 프로필 사진 1장씩 (DiceBear 'initials' avatar, display_name seed)
//   * voice-intro-audio 버킷에 ko/ja/en 3슬롯 TTS (스톡 보이스 합성)
//
// 사용:
//   npx tsx scripts/seed-dev-accounts.ts
//
// cleanup:
//   npx tsx scripts/cleanup-dev-accounts.ts
//
// 비용:
//   * ElevenLabs TTS 30회 (10명 × ko/ja/en 슬롯, 짧은 프리셋 문구 ~30자 평균)
//     → 합계 ~1500자, $0.30 미만
//   * Supabase Storage: 사진 10장(~0.5MB) + 음성 30개(~3MB)
//
// 마커: auth.users.user_metadata.is_dev_seed = true 로 식별 (닉네임/이메일에는 라벨 없음).
// cleanup 시 이 마커로 일괄 삭제.

import 'dotenv/config';
import { supabase } from '../src/config/supabase';
import { uploadFile } from '../src/services/storage';
import { generateVoiceIntroAudios } from '../src/services/voiceIntro';
import { lookupBioPhrase } from '../src/constants/bioPhrasesCatalog';

// ----- ElevenLabs 스톡 보이스 ID (성별 태깅) -----
// ElevenLabs 자체 premade voice library 에서 dating-app 톤만 선별 (저작권/도용 리스크 0).
// 모두 영어권 화자 기반이지만 eleven_v3 다국어 모델로 ko/ja 합성 지원 (약한 영어권
// 액센트 가능). ElevenLabs premade 풀 안엔 ko/ja native 화자가 없어 차선의 베스트.
//
// 라운드로빈 분배 순서는 PERSONAS 배열 순서에 맞춰 정렬됨:
//   FEMALE: Test4(KR), Test5(KR), Test6(JP), Test7(JP), Test8(JP)
//   MALE:   Test1(KR), Test2(KR), Test3(KR), Test9(JP), Test10(JP)
const STOCK_VOICES_FEMALE = [
  { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica' }, // Playful, Bright, Warm
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura' }, // Enthusiast, Quirky Attitude
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily' }, // Velvety Actress
  { id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Bella' }, // Professional, Bright, Warm
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice' }, // Clear, Engaging Educator
];

const STOCK_VOICES_MALE = [
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris' }, // Charming, Down-to-Earth
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam' }, // Energetic, Social Media Creator
  { id: 'bIHbv24MWmeRgasZH58o', name: 'Will' }, // Relaxed Optimist
  { id: 'cjVigY5qzO86Huf0OWal', name: 'Eric' }, // Smooth, Trustworthy
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' }, // Warm, Captivating Storyteller
];

// ----- 페르소나 10명 -----
// Test1~Test3: KR/ko/M, Test4~Test5: KR/ko/F, Test6~Test8: JP/ja/F, Test9~Test10: JP/ja/M
// → ko 5 + ja 5, 5M + 5F.
// phrase_id 는 bioPhrasesCatalog.ts 의 preset bypass 카탈로그에서 픽. 카탈로그가
// ko/ja/en 3슬롯 텍스트를 모두 보유하므로 Gemini 호출 0회.

type Persona = {
  display_name: string;
  birth_date: string; // YYYY-MM-DD
  gender: 'male' | 'female';
  nationality: string; // ISO 2-letter
  language: 'ko' | 'ja';
  interests: string[];
  phrase_id: string;
};

// voice_intro 텍스트 전원 통일: 'simple-1' phrase
//   ko: '그냥 자연스럽게 대화해봐요. 인연이면 이어지지 않을까요?'
//   ja: '自然に話してみませんか？縁があれば、きっと繋がりますよね。'
//   en: "Let's just chat naturally. If we click, things will fall into place, right?"
// interests 는 전원 빈 배열 — FE 가 viewer locale 로 i18n 번역해 표시할 게 없음.
const SHARED_PHRASE_ID = 'simple-1';

const PERSONAS: Persona[] = [
  // --- Test1~Test3: KR/ko/M (3명) ---
  {
    display_name: 'Test1',
    birth_date: '1997-05-08',
    gender: 'male',
    nationality: 'KR',
    language: 'ko',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
  {
    display_name: 'Test2',
    birth_date: '1994-09-17',
    gender: 'male',
    nationality: 'KR',
    language: 'ko',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
  {
    display_name: 'Test3',
    birth_date: '1995-06-11',
    gender: 'male',
    nationality: 'KR',
    language: 'ko',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
  // --- Test4~Test5: KR/ko/F (2명) ---
  {
    display_name: 'Test4',
    birth_date: '1998-03-15',
    gender: 'female',
    nationality: 'KR',
    language: 'ko',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
  {
    display_name: 'Test5',
    birth_date: '1999-07-22',
    gender: 'female',
    nationality: 'KR',
    language: 'ko',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
  // --- Test6~Test8: JP/ja/F (3명) ---
  {
    display_name: 'Test6',
    birth_date: '1995-11-30',
    gender: 'female',
    nationality: 'JP',
    language: 'ja',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
  {
    display_name: 'Test7',
    birth_date: '1999-02-14',
    gender: 'female',
    nationality: 'JP',
    language: 'ja',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
  {
    display_name: 'Test8',
    birth_date: '2000-08-03',
    gender: 'female',
    nationality: 'JP',
    language: 'ja',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
  // --- Test9~Test10: JP/ja/M (2명) ---
  {
    display_name: 'Test9',
    birth_date: '1996-12-25',
    gender: 'male',
    nationality: 'JP',
    language: 'ja',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
  {
    display_name: 'Test10',
    birth_date: '1998-04-19',
    gender: 'male',
    nationality: 'JP',
    language: 'ja',
    interests: [],
    phrase_id: SHARED_PHRASE_ID,
  },
];

// dev/QA 편의 — 비밀번호 전원 통일. 실유저 비밀번호 정책과 별개로 dev 전용.
// auth.users.user_metadata.is_dev_seed=true 마커가 있어야만 임퍼소네이션 허용되므로
// 비밀번호 노출 자체는 위협이 아니지만, 출시 전 cleanup:dev 로 일괄 삭제 필수.
const SEED_PASSWORD = 'aaaa1111';

// 크로스언어 선호 — 차별점 1 (디스커버 viewer-자국어 하드 제외) 가 활성화되려면
// preferred_languages / preferred_nationalities 가 반대편으로 향해야 매칭이 잘 보인다.
const PREF_BY_LANG: Record<'ko' | 'ja', { langs: string[]; nats: string[] }> = {
  ko: { langs: ['ja'], nats: ['JP'] },
  ja: { langs: ['ko'], nats: ['KR'] },
};

// ----- helpers -----

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 기본 프로필 사진 (DiceBear initials avatar, PNG).
// seed 로 display_name 사용 → Test1 은 "T1"·Test2 는 "T2" 등 식별 가능한 이니셜 원형 아바타.
// 외부 의존성 1개지만 Cloudflare 차단/rate-limit 이슈 없음.
async function fetchDefaultProfilePhoto(seed: string): Promise<Buffer> {
  const url = `https://api.dicebear.com/9.x/initials/png?seed=${encodeURIComponent(seed)}&size=512`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`dicebear HTTP ${res.status} (seed=${seed})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) {
    throw new Error(`dicebear 응답이 너무 작음 (${buf.length} bytes, seed=${seed})`);
  }
  return buf;
}

// 성별별로 스톡 보이스를 라운드로빈 분배.
function pickStockVoice(personasBefore: Persona[], gender: 'male' | 'female'): { id: string; name: string } {
  const pool = gender === 'female' ? STOCK_VOICES_FEMALE : STOCK_VOICES_MALE;
  const idx = personasBefore.filter((p) => p.gender === gender).length;
  return pool[idx % pool.length];
}

// ----- main -----

async function seedOne(
  index: number,
  persona: Persona,
  personasBefore: Persona[],
): Promise<{ email: string; password: string; userId: string }> {
  const email = `dev-${String(index + 1).padStart(2, '0')}@haru.test`;
  const password = SEED_PASSWORD;

  console.log(`\n[${index + 1}/${PERSONAS.length}] ${persona.display_name} (${persona.language}/${persona.gender}) — ${email}`);

  // 1) auth.users 생성
  const { data: userData, error: userErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { is_dev_seed: true, persona_index: index },
  });
  if (userErr || !userData?.user) {
    throw new Error(`auth.admin.createUser 실패: ${userErr?.message ?? 'no user returned'}`);
  }
  const userId = userData.user.id;

  // 2) 기본 프로필 사진 1장 다운로드 + Storage 업로드 (DiceBear initials, PNG).
  //    photos 컬럼은 TEXT[] 이므로 단일 URL 만 담아도 됨.
  const photoBuf = await fetchDefaultProfilePhoto(persona.display_name);
  const photoUrl = await uploadFile('photos', `${userId}/photo-0.png`, photoBuf, 'image/png');
  const photoUrls = [photoUrl];
  console.log('  photo uploaded');

  // 3) 스톡 보이스 선택
  const voice = pickStockVoice(personasBefore, persona.gender);
  console.log(`  voice: ${voice.name} (${voice.id})`);

  // 4) profiles INSERT (voice_intro 텍스트는 작성자 언어 슬롯 텍스트로)
  const phrase = lookupBioPhrase(persona.phrase_id);
  if (!phrase) {
    throw new Error(`phrase_id "${persona.phrase_id}" 가 bioPhrasesCatalog 에 없음`);
  }
  const authorText = phrase.text[persona.language];

  const { error: profileErr } = await supabase.from('profiles').insert({
    id: userId,
    display_name: persona.display_name,
    birth_date: persona.birth_date,
    gender: persona.gender,
    nationality: persona.nationality,
    language: persona.language,
    voice_intro: authorText,
    interests: persona.interests,
    photos: photoUrls,
    elevenlabs_voice_id: voice.id,
    voice_sample_url: null, // 스톡 보이스 — 원본 샘플 업로드 없음
    voice_clone_status: 'ready',
    is_active: true,
  });
  if (profileErr) {
    throw new Error(`profiles INSERT 실패: ${profileErr.message}`);
  }

  // 5) user_preferences INSERT (크로스언어 선호)
  const pref = PREF_BY_LANG[persona.language];
  const { error: prefErr } = await supabase.from('user_preferences').insert({
    user_id: userId,
    min_age: 20,
    max_age: 40,
    preferred_genders: persona.gender === 'female' ? ['male'] : ['female'],
    preferred_languages: pref.langs,
    preferred_nationalities: pref.nats,
  });
  if (prefErr) {
    throw new Error(`user_preferences INSERT 실패: ${prefErr.message}`);
  }

  // 6) voice intro 3슬롯 TTS — voiceIntro 서비스 직접 호출.
  //    preset 카탈로그가 ko/ja/en 3개 텍스트 보유 → Gemini 우회.
  //    내부에서 ElevenLabs TTS 3회 + Storage 업로드 + JSONB 컬럼 업데이트까지 수행.
  console.log('  generating voice intro audio (3 slots)...');
  await generateVoiceIntroAudios(userId, authorText, voice.id, persona.language, phrase.text, persona.gender);
  console.log('  ✓ voice intro audio ready');

  return { email, password, userId };
}

async function main() {
  console.log('=== haru dev account seed ===');
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ?? '(unset)'}`);
  console.log(`Personas: ${PERSONAS.length} (ko ${PERSONAS.filter((p) => p.language === 'ko').length} / ja ${PERSONAS.filter((p) => p.language === 'ja').length})`);
  console.log(`Gender: ${PERSONAS.filter((p) => p.gender === 'female').length}F / ${PERSONAS.filter((p) => p.gender === 'male').length}M`);
  console.log(`ElevenLabs TTS calls: ${PERSONAS.length * 3} (ko+ja+en per persona)`);
  console.log('\n5초 후 시작합니다. 취소하려면 Ctrl+C.');
  await sleep(5000);

  const results: { persona: Persona; email: string; password: string; userId: string }[] = [];
  const failures: { persona: Persona; error: string }[] = [];

  for (let i = 0; i < PERSONAS.length; i++) {
    const persona = PERSONAS[i];
    try {
      const out = await seedOne(i, persona, PERSONAS.slice(0, i));
      results.push({ persona, ...out });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ persona, error: msg });
      console.error(`  ✗ FAILED: ${msg}`);
    }
  }

  console.log('\n=== Seed complete ===');
  console.log(`성공: ${results.length} / 실패: ${failures.length}`);
  if (results.length > 0) {
    console.log('\n| display_name | email | password | user_id |');
    console.log('|---|---|---|---|');
    for (const r of results) {
      console.log(`| ${r.persona.display_name} | ${r.email} | ${r.password} | ${r.userId} |`);
    }
    console.log('\n* 비밀번호는 한 번만 표시됩니다. 필요하면 별도 기록.');
    console.log('* 마커: auth.users.user_metadata.is_dev_seed = true');
    console.log('* cleanup: npx tsx scripts/cleanup-dev-accounts.ts');
  }
  if (failures.length > 0) {
    console.log('\n실패 목록:');
    for (const f of failures) {
      console.log(`  - ${f.persona.display_name}: ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Seed aborted:', err);
  process.exit(1);
});
