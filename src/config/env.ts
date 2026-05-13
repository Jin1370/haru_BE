import dotenv from 'dotenv';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

dotenv.config();

// Cloud 배포 (Fly/Vercel) 환경 대응:
//   credentials/service-account.json 파일은 gitignored 라 빌드 이미지에 부재.
//   GOOGLE_APPLICATION_CREDENTIALS_JSON env 에 JSON 전체 내용을 넣어두면
//   startup 시점에 OS tmp dir 에 쓰고 GOOGLE_APPLICATION_CREDENTIALS 를 그 경로로 set.
//   로컬 개발은 기존대로 GOOGLE_APPLICATION_CREDENTIALS 파일 경로 사용 — 이 분기 스킵.
//
// 본 사이드 이펙트가 translation.ts (VertexAI 초기화) 보다 먼저 실행되도록
// env.ts 의 module 최상단에서 수행. 모든 라우트가 env.ts 를 transitive 하게
// import 하기 전 단계.
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (credentialsJson && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    JSON.parse(credentialsJson); // 형식 검증 (잘못된 JSON 이면 즉시 fail-fast)
    const credentialsPath = join(tmpdir(), 'gcp-service-account.json');
    writeFileSync(credentialsPath, credentialsJson, { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    console.log(`[env] GCP credentials written from env → ${credentialsPath}`);
  } catch (err) {
    console.error('[env] GOOGLE_APPLICATION_CREDENTIALS_JSON 파싱/쓰기 실패:', err);
    throw new Error('Invalid GOOGLE_APPLICATION_CREDENTIALS_JSON');
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
