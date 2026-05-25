import dotenv from 'dotenv';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { z } from 'zod';

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

  // message-moderation-v1 follow-up (B 안): OpenAI Moderation API key.
  // 사전 차단 layer 통과 후 omni-moderation-latest 호출 → 4 카테고리
  // (sexual / sexual-minors / illicit / self-harm-instructions) 임계치 초과 시 422.
  // 호출 자체 무료 (rate limit + 사용 데이터 OpenAI 수집은 별개). 키 미설정 시
  // OpenAI layer skip — 사전 차단만으로 동작 (fail-open). 본 분기를 명시적으로 두는
  // 이유: 로컬 개발자 + 기존 dev 환경 hot reload 시 키 없어도 서버 startup 차단 X.
  openai: {
    moderationApiKey: process.env.OPENAI_API_KEY || '',
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

  // message-moderation-v1 (PR2): 누적 신고 임계치.
  // routes/report.ts 가 INSERT 성공 후 reported_id 의 총 신고 수가 이 값에 도달하면
  // 자동 freeze (is_active=false + frozen_at=now()) + freeze_events INSERT.
  // 기본값 3 — strategist 권장은 5 였으나 사용자 결정으로 3 채택.
  // min=1 max=100 zod 검증 (0 또는 음수는 즉시 fail-fast).
  moderation: {
    autoFreezeReportThreshold: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(3)
      .parse(process.env.AUTO_FREEZE_REPORT_THRESHOLD),
  },

  // Email confirmation flow (Supabase enable_confirmations=true 정합).
  // signUp 시 emailRedirectTo 로 전달되며 Supabase Auth 가 보낸 확인 메일의
  // 링크 destination 이 된다. Supabase Dashboard 의 Redirect URLs allow-list
  // 에 동일 URL 이 등록되어야 거부되지 않음. 기본값은 dev local — production
  // 은 .env 의 EMAIL_CONFIRM_REDIRECT_URL 로 https://haruvoice.com/auth/callback.
  auth: {
    emailConfirmRedirectUrl:
      process.env.EMAIL_CONFIRM_REDIRECT_URL ||
      'http://localhost:3000/auth/callback',
  },
};
