import { env } from './config/env';

export const swaggerDocument = {
  openapi: '3.0.3',
  info: {
    title: '소개팅 API',
    description: '크로스 언어 소개팅 앱 백엔드 API',
    version: '2.0.0',
  },
  servers: [
    { url: `http://localhost:${env.port}`, description: 'Local' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Supabase access_token',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
      Profile: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          display_name: { type: 'string' },
          birth_date: { type: 'string', format: 'date' },
          gender: { type: 'string', enum: ['male', 'female', 'other'] },
          nationality: { type: 'string' },
          language: { type: 'string' },
          voice_intro: { type: 'string', nullable: true, description: '보이스 한마디 텍스트' },
          interests: { type: 'array', items: { type: 'string' } },
          photos: { type: 'array', items: { type: 'string', format: 'uri' } },
          elevenlabs_voice_id: { type: 'string', nullable: true },
          voice_sample_url: { type: 'string', nullable: true },
          voice_clone_status: { type: 'string', enum: ['pending', 'processing', 'ready', 'failed'] },
          voice_intro_audio_url: {
            type: 'string',
            format: 'uri',
            nullable: true,
            description: '작성자 언어 슬롯 URL 의 미러. 호환용 — voice_intro_audio_urls 로 마이그레이션 권장 (mig 011).',
          },
          voice_intro_translations: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: '보이스 인트로 다국어 텍스트. 키 ko/ja/en. 작성자 입력 슬롯은 원문, 나머지는 Gemini 번역문.',
          },
          voice_intro_audio_urls: {
            type: 'object',
            additionalProperties: { type: 'string', format: 'uri', nullable: true },
            description: '보이스 인트로 다국어 음성 URL. 키 ko/ja/en. 슬롯이 ready 상태일 때 URL, 미합성/실패 시 키 없음 또는 null.',
          },
          voice_intro_audio_status: {
            type: 'object',
            additionalProperties: { type: 'string', enum: ['pending', 'processing', 'ready', 'failed'] },
            description: '슬롯별 합성 상태. 키 ko/ja/en. 키 없음 = 미시도.',
          },
          is_active: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      PhotoAccess: {
        type: 'object',
        description: '상대 사진 공개 단계. main=프로필 메인 블러 해제, all=추가 사진 전체 조회 허용.',
        properties: {
          main_photo_unlocked: { type: 'boolean' },
          all_photos_unlocked: { type: 'boolean' },
        },
        required: ['main_photo_unlocked', 'all_photos_unlocked'],
      },
      ProfileCandidate: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          display_name: { type: 'string' },
          birth_date: { type: 'string', format: 'date' },
          gender: { type: 'string', enum: ['male', 'female', 'other'] },
          nationality: { type: 'string' },
          language: { type: 'string' },
          voice_intro: { type: 'string', nullable: true },
          interests: { type: 'array', items: { type: 'string' } },
          photos: {
            type: 'array',
            items: { type: 'string', format: 'uri' },
            description: 'discover 는 잠금 해제 대상 아님. 서버가 메인 1장으로 필터링(길이 0 또는 1).',
          },
          photo_access: {
            allOf: [{ $ref: '#/components/schemas/PhotoAccess' }],
            description: 'discover 정책상 항상 { false, false }.',
          },
        },
      },
      Match: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user1_id: { type: 'string', format: 'uuid' },
          user2_id: { type: 'string', format: 'uuid' },
          unmatched_at: { type: 'string', format: 'date-time', nullable: true },
          unmatched_by: { type: 'string', format: 'uuid', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      MatchWithPartner: {
        type: 'object',
        properties: {
          match_id: { type: 'string', format: 'uuid' },
          created_at: { type: 'string', format: 'date-time' },
          partner: {
            type: 'object',
            nullable: true,
            properties: {
              id: { type: 'string', format: 'uuid' },
              display_name: { type: 'string' },
              photos: {
                type: 'array',
                items: { type: 'string', format: 'uri' },
                description: 'all_photos_unlocked=true 이면 전체, 아니면 메인 1장(서버측 필터링).',
              },
              nationality: { type: 'string' },
              language: { type: 'string' },
            },
          },
          photo_access: { $ref: '#/components/schemas/PhotoAccess' },
          last_message: {
            type: 'object',
            nullable: true,
            properties: {
              id: { type: 'string', format: 'uuid' },
              original_text: { type: 'string' },
              sender_id: { type: 'string', format: 'uuid' },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
          unread_count: { type: 'integer' },
        },
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          match_id: { type: 'string', format: 'uuid' },
          sender_id: { type: 'string', format: 'uuid' },
          original_text: { type: 'string' },
          original_language: { type: 'string' },
          translated_text: { type: 'string', nullable: true },
          translated_language: { type: 'string', nullable: true },
          audio_url: { type: 'string', format: 'uri', nullable: true },
          audio_status: { type: 'string', enum: ['pending', 'processing', 'ready', 'failed'] },
          read_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Block: {
        type: 'object',
        properties: {
          blocked_id: { type: 'string', format: 'uuid' },
          created_at: { type: 'string', format: 'date-time' },
          profile: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              display_name: { type: 'string' },
              photos: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      UserPreference: {
        type: 'object',
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          min_age: { type: 'integer', minimum: 18, maximum: 100 },
          max_age: { type: 'integer', minimum: 18, maximum: 100 },
          preferred_genders: { type: 'array', items: { type: 'string', enum: ['male', 'female', 'other'] } },
          preferred_languages: {
            type: 'array',
            items: { type: 'string', minLength: 2, maxLength: 5 },
            description: '선호 언어 코드 (ko/ja/en/th/hi). 빈 배열이면 언어 제약 없음. mig 009 에서 level 차원 제거.',
          },
          preferred_nationalities: {
            type: 'array',
            items: { type: 'string', minLength: 2, maxLength: 5 },
            description: 'ISO-3166-1 alpha-2 국가 코드. 빈 배열이면 국가 제약 없음.',
          },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: '서버 상태 확인',
        security: [],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } } } },
        },
      },
    },

    // ── Auth ──
    '/api/auth/signup': {
      post: {
        tags: ['Auth'],
        summary: '이메일+비밀번호 회원가입',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } } } },
        },
        responses: {
          201: { description: '회원가입 성공', content: { 'application/json': { schema: { type: 'object', properties: { access_token: { type: 'string' }, refresh_token: { type: 'string' }, user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' } } } } } } } },
          400: { description: '입력 오류 또는 중복 이메일', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: '이메일+비밀번호 로그인',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } } } },
        },
        responses: {
          200: { description: '로그인 성공', content: { 'application/json': { schema: { type: 'object', properties: { access_token: { type: 'string' }, refresh_token: { type: 'string' }, user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' } } } } } } } },
          400: { description: 'email/password 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/google': {
      post: {
        tags: ['Auth'],
        summary: 'Google OAuth 로그인',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['id_token'], properties: { id_token: { type: 'string' } } } } },
        },
        responses: {
          200: { description: '로그인 성공', content: { 'application/json': { schema: { type: 'object', properties: { access_token: { type: 'string' }, refresh_token: { type: 'string' }, user: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string', format: 'email' } } } } } } } },
          400: { description: 'id_token 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '인증 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: '토큰 갱신',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } } } },
        },
        responses: {
          200: { description: '갱신 성공', content: { 'application/json': { schema: { type: 'object', properties: { access_token: { type: 'string' }, refresh_token: { type: 'string' } } } } } },
          400: { description: 'refresh_token 누락', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: '갱신 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Profile ──
    '/api/profile/me': {
      get: {
        tags: ['Profile'],
        summary: '내 프로필 조회',
        responses: {
          200: { description: '프로필', content: { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } } },
          404: { description: '프로필 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      put: {
        tags: ['Profile'],
        summary: '내 프로필 생성/수정 (upsert)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['display_name', 'birth_date', 'gender', 'nationality', 'language'],
                properties: {
                  display_name: { type: 'string', minLength: 1, maxLength: 50 },
                  birth_date: { type: 'string', format: 'date' },
                  gender: { type: 'string', enum: ['male', 'female', 'other'] },
                  nationality: { type: 'string', minLength: 2, maxLength: 5 },
                  language: { type: 'string', minLength: 2, maxLength: 5 },
                  voice_intro: { type: 'string', maxLength: 500 },
                  interests: { type: 'array', items: { type: 'string' }, maxItems: 10 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } } },
          400: { description: '유효성 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/profile/photos': {
      post: {
        tags: ['Profile'],
        summary: '프로필 사진 업로드 (최대 6장, 5MB)',
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['photo'], properties: { photo: { type: 'string', format: 'binary' } } } } } },
        responses: {
          200: { description: '업로드 성공', content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, photos: { type: 'array', items: { type: 'string', format: 'uri' } } } } } } },
          400: { description: '파일 없음 또는 6장 초과', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/profile/photos/{index}': {
      delete: {
        tags: ['Profile'],
        summary: '프로필 사진 삭제',
        parameters: [{ name: 'index', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } }],
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { type: 'object', properties: { photos: { type: 'array', items: { type: 'string' } } } } } } },
          400: { description: '잘못된 인덱스', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Voice ──
    '/api/voice/clone': {
      post: {
        tags: ['Voice'],
        summary: '음성 샘플 업로드 + ElevenLabs 클론 생성',
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['audio'], properties: { audio: { type: 'string', format: 'binary' } } } } } },
        responses: {
          200: { description: '클론 생성 완료', content: { 'application/json': { schema: { type: 'object', properties: { voice_id: { type: 'string' }, status: { type: 'string' } } } } } },
          500: { description: '클론 생성 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Voice'],
        summary: '음성 클론 삭제',
        responses: {
          200: { description: '삭제 성공', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } },
        },
      },
    },
    '/api/voice/status': {
      get: {
        tags: ['Voice'],
        summary: '음성 클론 상태 확인',
        responses: {
          200: { description: '상태', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'processing', 'ready', 'failed'] }, voice_id: { type: 'string', nullable: true } } } } } },
        },
      },
    },

    // ── Discover / Swipe ──
    '/api/discover': {
      get: {
        tags: ['Discover'],
        summary: '매칭 후보 목록 (스와이프/차단 유저 제외, 선호도 필터 적용)',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } }],
        responses: {
          200: { description: '후보 목록', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ProfileCandidate' } } } } },
        },
      },
    },
    '/api/discover/swipe': {
      post: {
        tags: ['Discover'],
        summary: '스와이프 (like/pass). 상호 like 시 매치 자동 생성',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['swiped_id', 'direction'], properties: { swiped_id: { type: 'string', format: 'uuid' }, direction: { type: 'string', enum: ['like', 'pass'] } } },
            },
          },
        },
        responses: {
          200: { description: '스와이프 완료', content: { 'application/json': { schema: { type: 'object', properties: { direction: { type: 'string' }, match: { $ref: '#/components/schemas/Match', nullable: true } } } } } },
          400: { description: '파라미터 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: '이미 스와이프함', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Matches ──
    '/api/matches': {
      get: {
        tags: ['Match'],
        summary: '내 매치 목록 (상대 프로필 + 마지막 메시지 + 읽지 않은 수)',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
          { name: 'before', in: 'query', schema: { type: 'string', format: 'date-time' }, description: '이 시각 이전 매치만 (커서)' },
        ],
        responses: {
          200: { description: '매치 목록', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/MatchWithPartner' } } } } },
        },
      },
    },
    '/api/matches/{matchId}': {
      delete: {
        tags: ['Match'],
        summary: '언매치 (soft delete)',
        parameters: [{ name: 'matchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: '언매치 성공', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'unmatched' } } } } } },
          404: { description: '매치 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Messages ──
    '/api/matches/{matchId}/messages': {
      get: {
        tags: ['Message'],
        summary: '메시지 목록 (커서 기반 페이지네이션)',
        parameters: [
          { name: 'matchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
          { name: 'before', in: 'query', schema: { type: 'string', format: 'date-time' }, description: '이 시각 이전 메시지만 (커서)' },
        ],
        responses: {
          200: { description: '메시지 목록', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } } },
          403: { description: '매치 비참여자', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Message'],
        summary: '메시지 전송 (번역 + 음성 더빙 자동 처리)',
        description: '텍스트 즉시 저장/응답, 음성 더빙 비동기 처리. 차단된 유저에게는 전송 불가.',
        parameters: [{ name: 'matchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } } } } } },
        responses: {
          201: { description: '전송 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } },
          400: { description: 'text 누락/초과', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: '매치 비참여자 / 차단됨', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/matches/{matchId}/messages/read': {
      patch: {
        tags: ['Message'],
        summary: '메시지 읽음 처리 (상대가 보낸 미읽 메시지 일괄)',
        parameters: [{ name: 'matchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: '읽음 처리 완료', content: { 'application/json': { schema: { type: 'object', properties: { read_count: { type: 'integer' } } } } } },
          403: { description: '매치 비참여자', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/matches/{messageId}/retry': {
      post: {
        tags: ['Message'],
        summary: '실패한 음성 더빙 재시도',
        parameters: [{ name: 'messageId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: '재시도 시작', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } },
          400: { description: 'failed 상태 아님 / voice clone 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: '메시지 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Block ──
    '/api/block': {
      post: {
        tags: ['Block'],
        summary: '유저 차단 (기존 매치 자동 언매치)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['blocked_id'], properties: { blocked_id: { type: 'string', format: 'uuid' } } } } } },
        responses: {
          201: { description: '차단 성공', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'blocked' } } } } } },
          400: { description: '자기 자신 차단 불가', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: '이미 차단됨', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['Block'],
        summary: '차단 목록',
        responses: {
          200: { description: '차단 목록', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Block' } } } } },
        },
      },
    },
    '/api/block/{blockedId}': {
      delete: {
        tags: ['Block'],
        summary: '차단 해제',
        parameters: [{ name: 'blockedId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: '차단 해제', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'unblocked' } } } } } },
        },
      },
    },

    // ── Report ──
    '/api/report': {
      post: {
        tags: ['Report'],
        summary: '유저 신고',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reported_id', 'reason'],
                properties: {
                  reported_id: { type: 'string', format: 'uuid' },
                  reason: { type: 'string', enum: ['spam', 'inappropriate', 'fake_profile', 'harassment', 'other'] },
                  description: { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: '신고 성공', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'reported' } } } } } },
          400: { description: '자기 자신 신고 불가', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: '이미 신고함', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Preferences ──
    '/api/preferences': {
      get: {
        tags: ['Preference'],
        summary: '매칭 선호도 조회',
        responses: {
          200: { description: '선호도', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserPreference' } } } },
        },
      },
      put: {
        tags: ['Preference'],
        summary: '매칭 선호도 설정',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  min_age: { type: 'integer', minimum: 18, maximum: 100, default: 18 },
                  max_age: { type: 'integer', minimum: 18, maximum: 100, default: 100 },
                  preferred_genders: { type: 'array', items: { type: 'string', enum: ['male', 'female', 'other'] } },
                  preferred_languages: {
                    type: 'array',
                    items: { type: 'string', minLength: 2, maxLength: 5 },
                  },
                  preferred_nationalities: {
                    type: 'array',
                    items: { type: 'string', minLength: 2, maxLength: 5 },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '설정 성공', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserPreference' } } } },
          400: { description: '유효성 오류', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
};
