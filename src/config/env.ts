import dotenv from 'dotenv';
dotenv.config();

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
