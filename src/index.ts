import './instrument'; // Sentry init — 반드시 다른 import보다 먼저
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { swaggerDocument } from './swagger';
import { errorMiddleware } from './middleware/error';
import configRoutes from './routes/config';
import authRoutes from './routes/auth';
import profileRoutes from './routes/profile';
import voiceRoutes from './routes/voice';
import swipeRoutes from './routes/swipe';
import matchRoutes from './routes/match';
import messageRoutes from './routes/message';
import blockRoutes from './routes/block';
import reportRoutes from './routes/report';
import preferenceRoutes from './routes/preference';
import notificationsRoutes from './routes/notifications';
import adminRoutes from './routes/admin';
import { startAudioExpiryScheduler } from './jobs/purgeExpiredAudio';
import { startAuditCleanupScheduler } from './jobs/cleanupAuditTables';
import { startPhotoConversionRetryScheduler } from './jobs/retryFailedPhotoConversions';

export const app = express();

// CORS — production 에서는 화이트리스트 strict, 개발 환경은 와이드 오픈 유지.
// CORS_ALLOWED_ORIGINS env 가 set 되어 있으면 콤마 분리 origin 만 허용.
// 모바일 앱(Expo native)은 browser 가 아니므로 CORS 영향 없음 — origin null 도 허용.
//
// glob 패턴 (* 와일드카드) 지원 — Vercel 의 deployment-specific URL 대응 위해.
//   예: 'https://haruadmin-*-sejin-ims-projects.vercel.app' 는
//       haruadmin-7rupppulw-sejin-ims-projects.vercel.app 등 매 배포 URL 매칭.
function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
function originMatches(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$');
  return regex.test(origin);
}

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (allowedOrigins.length > 0) {
  app.use(
    cors({
      origin: (origin, callback) => {
        // origin === undefined: 모바일 native / curl / 동일 출처 → 허용
        if (!origin) {
          callback(null, true);
          return;
        }
        if (allowedOrigins.some((p) => originMatches(origin, p))) {
          callback(null, true);
        } else {
          callback(new Error(`CORS blocked: ${origin}`));
        }
      },
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Admin-Secret',
        'X-Admin-Impersonate',
      ],
    }),
  );
  console.log(`[startup] CORS whitelist: ${allowedOrigins.join(', ')}`);
} else {
  // 로컬 개발/테스트 — 전체 허용 (CORS_ALLOWED_ORIGINS 미설정 시).
  app.use(cors());
}

app.use(express.json());

// Swagger
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Routes
// 강제 업데이트 게이트 — 인증 불필요. authMiddleware 없는 router 라 부팅 시
// 로그인 전에도 호출 가능 (옛 앱이 BE 와 통신하기 전에 차단되도록).
app.use('/api/config', configRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/discover', swipeRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/matches', messageRoutes);
app.use('/api/block', blockRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/preferences', preferenceRoutes);
app.use('/api/notifications', notificationsRoutes);

// dev/QA 어드민 라우트 — env.admin.dashboardEnabled=true 일 때만 mount.
// 출시 빌드에선 ADMIN_DASHBOARD_ENABLED 미설정 → 라우트 자체가 부재.
if (env.admin.dashboardEnabled) {
  app.use('/api/admin', adminRoutes);
  console.warn('[startup] /api/admin mounted (ADMIN_DASHBOARD_ENABLED=true). 출시 빌드에서는 disable 필수.');
}

// Error handling — Sentry 핸들러를 커스텀 errorMiddleware "앞"에 등록해야
// 모든 라우트 에러를 캡처한 뒤 errorMiddleware 가 응답을 내려준다.
Sentry.setupExpressErrorHandler(app);
app.use(errorMiddleware);

if (process.env.NODE_ENV !== 'test') {
  app.listen(env.port, () => {
    console.log(`Server running on port ${env.port}`);
  });
  // audio-expiry sprint: 청취 완료 + 30일 경과 음성 파일 일일 sweep 등록.
  // NODE_ENV=test 분기는 scheduler 내부에서도 가드되지만, listen 과 함께 묶어
  // 부팅 sequence 를 단일 위치로 유지.
  startAudioExpiryScheduler();
  // audit-cleanup sprint: moderation_blocks / freeze_events 365일 보관 정책
  // (PIPA §21 + GDPR Art.5(1)(e) data minimization). 같은 24h interval + unref 패턴.
  startAuditCleanupScheduler();
  // photo-watercolor-pipeline sprint: pending/failed 사진 변환 재시도 sweep.
  // 부팅 120s 후 1회 + 10 분 interval. 백필 row 처리 + transient 실패 자동 복구.
  startPhotoConversionRetryScheduler();
}
