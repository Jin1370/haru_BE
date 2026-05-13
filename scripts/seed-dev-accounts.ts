// 개발 환경용 더미 계정 10명 시드.
//
// 만들어내는 것:
//   * auth.users 10명 (email/password, email_confirm=true, user_metadata.is_dev_seed=true)
//   * profiles 10건 (ko 5 / ja 5, 5F/5M, voice clone status = ready, 스톡 voice_id)
//   * user_preferences 10건 (크로스언어 매칭 — ko → ja/JP 선호, ja → ko/KR 선호)
//   * photos 버킷에 AI 생성 얼굴 2장씩 (thispersondoesnotexist.com)
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
//   * Supabase Storage: 사진 20장(~2MB) + 음성 30개(~3MB)
//
// 마커: auth.users.user_metadata.is_dev_seed = true 로 식별 (닉네임/이메일에는 라벨 없음).
// cleanup 시 이 마커로 일괄 삭제.

import 'dotenv/config';
import { randomBytes } from 'crypto';
import { supabase } from '../src/config/supabase';
import { uploadFile } from '../src/services/storage';
import { generateVoiceIntroAudios } from '../src/services/voiceIntro';
import { lookupBioPhrase } from '../src/constants/bioPhrasesCatalog';

// ----- ElevenLabs 스톡 보이스 ID (성별 태깅) -----
// 공식 default voice library. eleven_v3 는 단일 보이스로 다국어 합성 가능.
const STOCK_VOICES_FEMALE = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
  { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli' },
  { id: 'ThT5KcBeYPX3keUQqHPh', name: 'Dorothy' },
];

const STOCK_VOICES_MALE = [
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh' },
  { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam' },
];

// ----- 페르소나 10명 -----
// ko 5 (3F + 2M), ja 5 (2F + 3M) → 합계 5F + 5M.
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

const PERSONAS: Persona[] = [
  // --- ko 3F + 2M ---
  {
    display_name: '서연',
    birth_date: '1998-03-15',
    gender: 'female',
    nationality: 'KR',
    language: 'ko',
    interests: ['카페투어', '여행', '사진'],
    phrase_id: 'taste-1',
  },
  {
    display_name: '하늘',
    birth_date: '1999-07-22',
    gender: 'female',
    nationality: 'KR',
    language: 'ko',
    interests: ['독서', '영화', '요가'],
    phrase_id: 'sincere-1',
  },
  {
    display_name: '지호',
    birth_date: '1995-11-30',
    gender: 'female',
    nationality: 'KR',
    language: 'ko',
    interests: ['운동', '쿠킹', '와인'],
    phrase_id: 'flutter-1',
  },
  {
    display_name: '준영',
    birth_date: '1997-05-08',
    gender: 'male',
    nationality: 'KR',
    language: 'ko',
    interests: ['게임', '드라이브', '음악감상'],
    phrase_id: 'simple-1',
  },
  {
    display_name: '도현',
    birth_date: '1994-09-17',
    gender: 'male',
    nationality: 'KR',
    language: 'ko',
    interests: ['헬스', '러닝', '맛집'],
    phrase_id: 'confidence-1',
  },
  // --- ja 2F + 3M ---
  {
    display_name: 'さくら',
    birth_date: '1999-02-14',
    gender: 'female',
    nationality: 'JP',
    language: 'ja',
    interests: ['カフェ巡り', '読書', '旅行'],
    phrase_id: 'simple-2',
  },
  {
    display_name: 'ゆい',
    birth_date: '2000-08-03',
    gender: 'female',
    nationality: 'JP',
    language: 'ja',
    interests: ['アニメ', '音楽', 'ピアノ'],
    phrase_id: 'aegyo-1',
  },
  {
    display_name: 'はるき',
    birth_date: '1996-12-25',
    gender: 'male',
    nationality: 'JP',
    language: 'ja',
    interests: ['映画', 'ジム', 'ワイン'],
    phrase_id: 'flutter-2',
  },
  {
    display_name: 'たくみ',
    birth_date: '1998-04-19',
    gender: 'male',
    nationality: 'JP',
    language: 'ja',
    interests: ['サッカー', 'ギター', 'ラーメン'],
    phrase_id: 'sincere-1',
  },
  {
    display_name: 'けんた',
    birth_date: '1995-06-11',
    gender: 'male',
    nationality: 'JP',
    language: 'ja',
    interests: ['登山', '写真', 'バイク'],
    phrase_id: 'taste-1',
  },
];

// 크로스언어 선호 — 차별점 1 (디스커버 viewer-자국어 하드 제외) 가 활성화되려면
// preferred_languages / preferred_nationalities 가 반대편으로 향해야 매칭이 잘 보인다.
const PREF_BY_LANG: Record<'ko' | 'ja', { langs: string[]; nats: string[] }> = {
  ko: { langs: ['ja'], nats: ['JP'] },
  ja: { langs: ['ko'], nats: ['KR'] },
};

// ----- helpers -----

function randomPassword(): string {
  // 18자 base64url (영숫자 + - _). Supabase 기본 password policy 통과.
  return randomBytes(14).toString('base64url');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// AI 얼굴 다운로드 — thispersondoesnotexist.com.
// 매 GET 마다 새 얼굴. 동일 IP 에서 빠르게 받으면 동일 이미지가 캐시될 수 있어
// 호출 사이에 짧은 sleep 을 넣어 캐시 회전 보장. Cloudflare 차단 시 명확한
// 에러로 알린다.
async function fetchAIFace(attempt = 1): Promise<Buffer> {
  const res = await fetch('https://thispersondoesnotexist.com/', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });
  if (!res.ok) {
    if (attempt < 3) {
      await sleep(2000);
      return fetchAIFace(attempt + 1);
    }
    throw new Error(
      `thispersondoesnotexist.com HTTP ${res.status}. 차단된 것 같습니다. ` +
        `VPN/네트워크 변경 후 재시도하거나 fetchAIFace() 를 다른 소스로 교체하세요.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 30 * 1024) {
    throw new Error(`AI face 응답이 너무 작음 (${buf.length} bytes) — placeholder/captcha 의심`);
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
  const password = randomPassword();

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

  // 2) AI 얼굴 2장 다운로드 + Storage 업로드
  const photoUrls: string[] = [];
  for (let p = 0; p < 2; p++) {
    const faceBuf = await fetchAIFace();
    const url = await uploadFile('photos', `${userId}/photo-${p}.jpg`, faceBuf, 'image/jpeg');
    photoUrls.push(url);
    await sleep(1500); // 캐시 회전 + rate limit 회피
    console.log(`  photo ${p + 1}/2 uploaded`);
  }

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
  await generateVoiceIntroAudios(userId, authorText, voice.id, persona.language, phrase.text);
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
