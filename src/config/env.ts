import dotenv from 'dotenv';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

dotenv.config();

// Cloud 배포 (Fly/Vercel) 환경 대응:
//   credentials/service-account.json 파일은 gitignored 라 빌드 이미지에 부재.
//   다음 env 중 하나로 service account JSON 을 받아 startup 에 OS tmp dir 에 작성:
//     * GOOGLE_APPLICATION_CREDENTIALS_JSON_B64  ← 권장 (base64, Windows PowerShell argv 안전)
//     * GOOGLE_APPLICATION_CREDENTIALS_JSON       ← 원본 JSON 문자열 (Unix shell 에서만 안전)
//   로컬 개발은 GOOGLE_APPLICATION_CREDENTIALS 파일 경로 사용 (이 분기 스킵).
//
// 본 사이드 이펙트가 translation.ts (VertexAI 초기화) 보다 먼저 실행되도록
// env.ts 의 module 최상단에서 수행.
const credentialsB64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON_B64;
const credentialsJsonRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if ((credentialsB64 || credentialsJsonRaw) && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const jsonText = credentialsB64
      ? Buffer.from(credentialsB64, 'base64').toString('utf-8')
      : (credentialsJsonRaw as string);
    JSON.parse(jsonText); // 형식 검증 (잘못된 JSON 이면 즉시 fail-fast)
    const credentialsPath = join(tmpdir(), 'gcp-service-account.json');
    writeFileSync(credentialsPath, jsonText, { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    console.log(
      `[env] GCP credentials written from ${credentialsB64 ? 'B64' : 'JSON'} env → ${credentialsPath}`,
    );
  } catch (err) {
    console.error('[env] GCP credentials env 파싱/쓰기 실패:', err);
    throw new Error(
      'Invalid GCP credentials env. Use GOOGLE_APPLICATION_CREDENTIALS_JSON_B64 (base64-encoded JSON) for cloud deploys.',
    );
  }
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    jwtSecret: required('SUPABASE_JWT_SECRET'),
  },

  elevenlabs: {
    apiKey: required('ELEVENLABS_API_KEY'),
  },

  vertexAi: {
    projectId: required('GCP_PROJECT_ID'),
    location: process.env.GCP_LOCATION || 'us-central1',
  },

  // dev/QA 어드민 대시보드 — 출시 빌드에서는 ADMIN_DASHBOARD_ENABLED 미설정
  // 으로 라우트/임퍼소네이션 경로 자체가 사라진다. ADMIN_SECRET 은 enabled
  // 일 때만 required. 프로덕션에서 실수로 활성화 + 빈 시크릿 = 무제한 침해
  // 시나리오를 차단.
  admin: {
    dashboardEnabled: process.env.ADMIN_DASHBOARD_ENABLED === 'true',
    secret:
      process.env.ADMIN_DASHBOARD_ENABLED === 'true'
        ? required('ADMIN_SECRET')
        : '',
  },
};
