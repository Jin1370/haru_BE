// dev seed 계정 사진을 Vertex AI Imagen 으로 demographic-specific 자연스러운
// 얼굴로 일괄 교체.
//
// 각 계정의 profiles 에서 (language, nationality, gender, birth_date) 를 읽고
// 그에 맞는 프롬프트로 Imagen 3 Fast 모델 호출. 결과를 Supabase Storage 의
// photos/{user_id}/photo-0.jpg 에 overwrite + profiles.photos 갱신.
//
// 사용:
//   cd haru_BE
//   npx tsx scripts/update-dev-photos.ts
//   npx tsx scripts/update-dev-photos.ts --dry-run        # Imagen 호출만 보고 업로드 안 함
//   npx tsx scripts/update-dev-photos.ts --only Test1     # 특정 display_name 만
//
// 비용: Imagen 3 Fast = $0.02/장. 12명 × 1장 = ~$0.24.
//
// 사전 조건:
//   * GCP 콘솔 → "Vertex AI API" 활성화 (Gemini 쓰고 있으면 이미 활성)
//   * GCP_PROJECT_ID 환경변수 set
//   * GOOGLE_APPLICATION_CREDENTIALS 가 valid service account JSON 가리킴
//
// 안전: personGeneration='allow_adult' — 미성년자 생성 차단, 성인은 허용.

import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { supabase } from '../src/config/supabase';
import { uploadFile } from '../src/services/storage';

const DRY_RUN = process.argv.includes('--dry-run');
const onlyIdx = process.argv.indexOf('--only');
const ONLY_NAME = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

// Imagen 은 us-central1 또는 europe-west4 에서만 가능. GCP_LOCATION 이 다른 region 이어도 hardcode.
const IMAGEN_REGION = 'us-central1';
const IMAGEN_MODEL = 'imagen-3.0-fast-generate-001';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

async function getAccessToken(): Promise<string> {
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!saPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS 미설정');
  const sa = JSON.parse(readFileSync(saPath, 'utf-8')) as ServiceAccount;

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    },
    sa.private_key,
    { algorithm: 'RS256' },
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth token 발급 실패: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function generateImage(prompt: string, accessToken: string): Promise<Buffer> {
  const project = process.env.GCP_PROJECT_ID;
  if (!project) throw new Error('GCP_PROJECT_ID 미설정');
  const url = `https://${IMAGEN_REGION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${IMAGEN_REGION}/publishers/google/models/${IMAGEN_MODEL}:predict`;

  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: '3:4',
      personGeneration: 'allow_adult',
      // safetyFilterLevel: 'block_only_high', // 필요 시 완화
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Imagen 호출 실패: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    predictions?: Array<{ bytesBase64Encoded?: string; raiFilteredReason?: string }>;
  };
  const pred = json.predictions?.[0];
  if (!pred?.bytesBase64Encoded) {
    if (pred?.raiFilteredReason) {
      throw new Error(`Imagen RAI 필터링: ${pred.raiFilteredReason}`);
    }
    throw new Error(`Imagen 응답에 이미지 없음: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return Buffer.from(pred.bytesBase64Encoded, 'base64');
}

function ageFromBirthDate(birthDate: string): number {
  const yr = new Date(birthDate).getFullYear();
  return new Date().getFullYear() - yr;
}

function ageGroup(age: number): string {
  if (age < 25) return 'early 20s';
  if (age < 30) return 'late 20s';
  if (age < 35) return 'early 30s';
  if (age < 40) return 'mid 30s';
  return 'late 30s';
}

function ethnicityFromNationality(nat: string | null): string {
  if (nat === 'KR') return 'Korean';
  if (nat === 'JP') return 'Japanese';
  if (nat === 'US') return 'American';
  if (nat === 'TH') return 'Thai';
  if (nat === 'IN') return 'Indian';
  return 'East Asian';
}

// 일상 컨텍스트 — 계정별로 다양성 주기 위해 user_id 해시로 결정적 선택.
const SETTINGS = [
  'in a cozy café with warm afternoon window light',
  'walking down a quiet city street in soft daylight',
  'sitting on a couch at home with natural indoor lighting',
  'at a park during golden hour',
  'at a desk in a small bookstore or cozy library',
  'by a window in an apartment, looking thoughtfully',
  'in a casual restaurant booth, mid-conversation',
  'on a subway or train platform with ambient station light',
  'on a bench in an urban park, soft cloudy daylight',
  'at a kitchen counter with morning sunlight',
  'next to a vending machine on a city sidewalk',
  'on a rooftop terrace with bokeh city background',
];

const EXPRESSIONS = [
  'mid-laugh with eyes slightly squinting',
  'looking off-camera with a relaxed soft smile',
  'looking down at a coffee cup, contemplative',
  'caught talking to someone off-frame',
  'a genuine subtle smile, eyes warm',
  'slightly tilted head, casual expression',
];

function pickByHash<T>(arr: T[], key: string): T {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return arr[Math.abs(h) % arr.length];
}

function craftPrompt(
  p: { language: string; nationality: string; gender: string; birth_date: string; user_id: string },
): string {
  const ethnicity = ethnicityFromNationality(p.nationality);
  const age = ageFromBirthDate(p.birth_date);
  const group = ageGroup(age);
  const genderWord = p.gender === 'female' ? 'woman' : p.gender === 'male' ? 'man' : 'person';
  const setting = pickByHash(SETTINGS, p.user_id);
  const expression = pickByHash(EXPRESSIONS, p.user_id + 'exp');
  // 일상 스냅샷 풍 — 증명사진 스타일 회피. positive descriptions 만 사용 (Imagen 은 negative prompt 미지원).
  return (
    `A candid everyday snapshot photograph of an ordinary ${ethnicity} ${genderWord} in their ${group}, ` +
    `captured ${setting}, ${expression}. ` +
    `Phone camera aesthetic, amateur photography style, ` +
    `ordinary realistic face like a normal everyday person not a model, ` +
    `casual everyday clothing, slightly off-center composition, soft natural ambient lighting, ` +
    `looks like a spontaneous photo taken by a friend, ` +
    `social media or messenger style photo, ` +
    `unposed natural moment from daily life`
  );
}

type DevAccount = {
  user_id: string;
  display_name: string;
  language: string;
  nationality: string;
  gender: string;
  birth_date: string;
};

async function listDevAccounts(): Promise<DevAccount[]> {
  // auth.users 에서 is_dev_seed=true 찾고 profiles 와 조인
  const ids: string[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers 실패: ${error.message}`);
    for (const u of data.users) {
      const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
      if (meta.is_dev_seed === true) ids.push(u.id);
    }
    if (data.users.length < 1000) break;
    page++;
  }

  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, language, nationality, gender, birth_date')
    .in('id', ids);
  if (error) throw new Error(`profiles fetch 실패: ${error.message}`);

  return (data ?? [])
    .map((r) => ({
      user_id: r.id as string,
      display_name: (r.display_name as string) ?? '',
      language: (r.language as string) ?? '',
      nationality: (r.nationality as string) ?? '',
      gender: (r.gender as string) ?? '',
      birth_date: (r.birth_date as string) ?? '',
    }))
    .filter((p) => p.birth_date && p.gender && p.nationality);
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function main() {
  console.log('=== haru dev photo update (Imagen) ===');
  if (DRY_RUN) console.log('** DRY RUN **');
  if (ONLY_NAME) console.log(`** --only ${ONLY_NAME} **`);

  let accounts = await listDevAccounts();
  accounts.sort((a, b) => naturalSort(a.display_name, b.display_name));
  if (ONLY_NAME) accounts = accounts.filter((a) => a.display_name === ONLY_NAME);

  console.log(`\n대상 ${accounts.length}명:`);
  for (const a of accounts) {
    const age = ageFromBirthDate(a.birth_date);
    console.log(
      `  ${a.display_name.padEnd(8)} ${a.language}/${a.nationality} ${a.gender} ${age}세  → ${ethnicityFromNationality(a.nationality)} ${a.gender === 'female' ? 'woman' : 'man'} ${ageGroup(age)}`,
    );
  }
  if (accounts.length === 0) return;

  if (!DRY_RUN) {
    console.log('\n5초 후 시작합니다. 취소하려면 Ctrl+C.');
    await new Promise((r) => setTimeout(r, 5000));
  }

  const accessToken = await getAccessToken();
  console.log('\nOAuth access token 발급 완료');

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const prompt = craftPrompt(a);
    console.log(`\n[${i + 1}/${accounts.length}] ${a.display_name}`);
    console.log(`  prompt: ${prompt.slice(0, 100)}...`);

    try {
      if (DRY_RUN) {
        console.log('  [dry] Imagen 호출 + 업로드 스킵');
        ok++;
        continue;
      }

      const buf = await generateImage(prompt, accessToken);
      console.log(`  ✓ Imagen 응답 ${(buf.length / 1024).toFixed(1)} KB`);

      // 새 파일명 (timestamp 포함) 으로 업로드 — Storage URL 변경 보장으로 브라우저/CDN
      // 캐시 우회. 옛 photo-0.jpg 는 Storage 에 orphan 으로 남지만 화면 영향 없음.
      const path = `${a.user_id}/photo-${Date.now()}.jpg`;
      const publicUrl = await uploadFile('photos', path, buf, 'image/jpeg');
      console.log(`  ✓ upload → ${publicUrl}`);

      // mig 034: profiles.photos 폐지 → profile_photos 메인(position=0) 행 upsert.
      //   변환 없이 바로 status='ready' (converted_url = 업로드 URL).
      const { error: updateErr } = await supabase
        .from('profile_photos')
        .upsert(
          {
            user_id: a.user_id,
            position: 0,
            original_path: path,
            converted_url: publicUrl,
            status: 'ready',
            failure_reason: null,
          },
          { onConflict: 'user_id,position' },
        );
      if (updateErr) throw new Error(`profile_photos upsert 실패: ${updateErr.message}`);
      console.log('  ✓ profile_photos 갱신');
      ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ 실패: ${msg}`);
      fail++;
    }
  }

  console.log('\n=== Photo update complete ===');
  console.log(`성공: ${ok} / 실패: ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Aborted:', err);
  process.exit(1);
});
