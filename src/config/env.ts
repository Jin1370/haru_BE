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

  // 프로필 사진 워터컬러 변환 (photo-watercolor-pipeline) — Azure OpenAI(APIM 프록시).
  // 회사 제공 키. baseUrl + apiKey 둘 다 set 되면 photoConversion 의 getClient 가
  // OpenAI 직접 대신 Azure 경유 클라이언트를 구성한다 (baseURL + api-key 헤더 + api-version 쿼리).
  // 미설정 시 openai.moderationApiKey 로 OpenAI 직접 호출 (fallback, 옛 동작).
  //   * baseUrl 은 deployment 까지 포함 (.../deployments/<name>). APIM 매핑상 경로에 /openai 없음.
  //   * ⚠️ 발급 키는 dev/test 전용 — 총 모델 호출 500회 캡. 출시 전 prod 한도 별도 협의 필요.
  image: {
    azureBaseUrl: process.env.AZURE_IMAGE_BASE_URL || '',
    azureApiKey: process.env.AZURE_IMAGE_API_KEY || '',
    azureApiVersion: process.env.AZURE_IMAGE_API_VERSION || '2025-04-01-preview',
  },

  vertexAi: {
    projectId: required('GCP_PROJECT_ID'),
    location: process.env.GCP_LOCATION || 'us-central1',
  },

  // 디스커버 "지나친 카드 다시 보기" (pass 스와이프 리셋) 일몰 게이트.
  // viewer 의 direction='pass' 스와이프 행을 일괄 삭제해 pass 했던 후보를 다시
  // 디스커버 풀에 등장시키는 베타 풀-고갈 탈출구 (strategist C2). 베타 기본 ON,
  // 유저 스케일 임계 도달 시 코드 배포 없이 false 로 끈다 — 1000명+ 규모에선
  // "거절한 상대 재노출" 이 데이팅앱 표준 UX 위반이라 일몰 대상.
  // 비활성 시 DELETE /api/discover/passes 는 403 + code:'pass_reset_disabled',
  // GET /quota 의 pass_reset_enabled 플래그도 false → FE 가 버튼을 숨긴다.
  // admin.dashboardEnabled 게이트 패턴 재사용. 기본값 ON (미설정 시 활성).
  discover: {
    passResetEnabled: process.env.DISCOVER_PASS_RESET_ENABLED !== 'false',
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

  // 재녹음(voice clone 재생성) 레이트리밋 — ElevenLabs 월간 voice operations
  // 쿼터(계정 공유 풀)를 1인 어뷰즈로부터 보호. 최초 등록은 카운트 제외, 재등록만
  // 윈도우당 캡. 기본 2회 / 30일 (사용자 결정). routes/voice.ts POST /clone 적용.
  // 삭제는 op 아님 → 재녹음 1회 = 1 op. 정상 사용(가입 분산 + 드문 재녹음)은
  // 절대 안 걸리고, 인위적 몰림/어뷰즈만 차단.
  voice: {
    recloneMonthlyCap: z.coerce.number().int().min(1).max(100).default(2)
      .parse(process.env.VOICE_RECLONE_MONTHLY_CAP),
    recloneWindowDays: z.coerce.number().int().min(1).max(365).default(30)
      .parse(process.env.VOICE_RECLONE_WINDOW_DAYS),
  },

  // 강제 업데이트 게이트 (최소판). 인증 불필요한 GET /api/config 로 노출.
  // FE 가 부팅 시 자기 앱 버전과 minVersion 을 비교해 미만이면 차단 화면을 띄운다.
  // 스키마를 깨는 BE/DB 변경 시 MIN_APP_VERSION 을 올리면 그 미만 앱(옛 응답 형태를
  // 기대하는 클라이언트)을 끊어낸다. 평소엔 1.0.0 그대로 둬서 아무도 안 막힘.
  // 마이그 없음 — 값은 env 라 재배포(또는 env 변경 + 재시작)만으로 조정.
  // 스토어 URL 도 서버가 제공 — 잘못된 링크를 앱에 박제하지 않고 나중에 교체 가능.
  // iOS 는 App Store 등록 전이라 기본 빈 문자열 (FE 가 빈 값이면 버튼 숨김).
  appConfig: {
    minVersion: process.env.MIN_APP_VERSION || '1.0.0',
    iosStoreUrl: process.env.IOS_STORE_URL || '',
    androidStoreUrl:
      process.env.ANDROID_STORE_URL ||
      'https://play.google.com/store/apps/details?id=com.haruvoice.app',
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
