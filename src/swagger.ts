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
      // message-moderation-v1 (PR2): freeze 사용자 mutating 라우트 가드 응답.
      // FE 의 services/api.ts 글로벌 핸들러가 `code: 'account_frozen'` 매칭으로
      // 모달 1회 + 로그아웃 흐름 발화. 가드 적용 라우트:
      //   POST /api/discover/swipe / POST /api/matches/{matchId}/messages /
      //   POST /api/matches/{matchId}/hide / PUT /api/profile/me /
      //   POST /api/profile/photos / DELETE /api/profile/photos/{index} /
      //   POST /api/voice/clone
      AccountFrozenError: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Account frozen' },
          code: { type: 'string', example: 'account_frozen' },
        },
        required: ['error', 'code'],
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
              audio_status: {
                type: 'string',
                enum: ['pending', 'processing', 'ready', 'failed'],
                nullable: true,
                description:
                  'read-at-removal-list-mask (mig 017 v3): 마지막 메시지의 status. FE 마스킹 분기에서 ready 만 미리보기 후보로 처리.',
              },
              listened_at: {
                type: 'string',
                format: 'date-time',
                nullable: true,
                description:
                  'read-at-removal-list-mask (mig 017 v3): viewer 가 마지막 메시지의 음성을 청취 완료한 시각. 상대 발신 + NULL 이면 FE 가 "새 메시지" 마스킹을 적용.',
              },
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
          listened_at: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description:
              'voice-first-message-gate (mig 015): 수신자가 음성을 1회 끝까지 재생한 시각. NULL = 미청취 → FE 가 텍스트를 숨기고 편지 UI 만 노출. 본인 발신 메시지는 항상 null.',
          },
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
          403: { description: '계정 정지 (frozen) — code: account_frozen', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountFrozenError' } } } },
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
          403: { description: '계정 정지 (frozen) — code: account_frozen', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountFrozenError' } } } },
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
          403: { description: '계정 정지 (frozen) — code: account_frozen', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountFrozenError' } } } },
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
          403: { description: '계정 freeze (message-moderation-v1 PR2)', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountFrozenError' } } } },
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
          403: { description: '계정 freeze (message-moderation-v1 PR2)', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountFrozenError' } } } },
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
          403: { description: '계정 freeze (message-moderation-v1 PR2)', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountFrozenError' } } } },
        },
      },
    },

    // ── Voice ──
    '/api/voice/clone': {
      post: {
        tags: ['Voice'],
        summary: '음성 샘플 업로드 + ElevenLabs 클론 생성 (신규 등록 / 재등록 덮어쓰기)',
        description:
          '기존 voice_id 가 있을 경우 새 clone 생성 성공 후 옛 voice 를 ElevenLabs 측에서 자동 정리한다. ' +
          '단독 삭제 라우트는 의도적으로 제공하지 않음 — voice-clone 없는 발신자 메시지가 채팅에서 "메시지 준비 중.." 영구 락을 만드는 회귀를 방지. ' +
          '데이터 삭제권은 계정 탈퇴 라우트가 보장한다.',
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['audio'], properties: { audio: { type: 'string', format: 'binary' } } } } } },
        responses: {
          200: { description: '클론 생성 완료', content: { 'application/json': { schema: { type: 'object', properties: { voice_id: { type: 'string' }, status: { type: 'string' } } } } } },
          403: { description: '계정 freeze (message-moderation-v1 PR2)', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountFrozenError' } } } },
          500: { description: '클론 생성 실패', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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
    '/api/discover/likes-received': {
      get: {
        tags: ['Discover'],
        summary: '받은 좋아요 목록 (나를 like 한 사용자 중 미스와이프·비차단 후보)',
        description: '응답 shape 은 /api/discover 와 동일 (사진 1장, photo_access 잠금, voice intro 시청자 언어 슬롯 미러). 정렬은 like 한 시각 내림차순.',
        responses: {
          200: { description: '받은 좋아요 목록', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ProfileCandidate' } } } } },
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
          403: { description: '계정 freeze (message-moderation-v1 PR2)', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountFrozenError' } } } },
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
    '/api/matches/{matchId}/partner': {
      get: {
        tags: ['Match'],
        summary: '채팅 상대의 부가 프로필 (시청자 언어 보이스 인트로 미러)',
        description:
          'birth_date / interests / 시청자 언어 슬롯의 voice_intro_audio_url 을 반환. ' +
          'voice_intro_audio_url 은 viewer 의 profiles.language → ko/ja/en 슬롯 매핑으로 ' +
          'voice_intro_audio_urls JSONB 에서 추출해 미러한다(디스커버 응답과 동일 정책). ' +
          'FE 가 supabase 에서 단일 voice_intro_audio_url 컬럼을 직접 select 하던 경로를 대체.',
        parameters: [
          { name: 'matchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'PartnerDetail',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['birth_date', 'interests', 'voice_intro_audio_url'],
                  properties: {
                    birth_date: { type: 'string', format: 'date' },
                    interests: { type: 'array', items: { type: 'string' } },
                    voice_intro_audio_url: { type: 'string', format: 'uri', nullable: true },
                  },
                },
              },
            },
          },
          404: { description: '매치 없음 또는 상대 프로필 없음', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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
        summary: '메시지 전송 (큐잉 → 비동기 INSERT)',
        description:
          'POST 는 stub 메시지(id=확정된 UUID, audio_status=pending)를 즉시 반환하며 DB INSERT 는 하지 않는다. ' +
          '비동기 파이프라인(번역 + ElevenLabs TTS + Storage 업로드)이 완료되면 마지막에 한 번만 INSERT — ' +
          'realtime INSERT 가 1회만 발생해 expo-audio 의 mid-session player resource 회수 트리거를 회피한다. ' +
          '파이프라인 실패 시에도 audio_url=null, audio_status=failed 로 INSERT 되어 텍스트는 전달된다.',
        parameters: [{ name: 'matchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } } } } } },
        responses: {
          202: { description: '큐잉 성공 — INSERT 는 realtime 으로 도착', content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } },
          400: { description: 'text 누락/초과', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: {
            description: '매치 비참여자 / 차단됨 / 계정 freeze (message-moderation-v1 PR2)',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/Error' },
                    { $ref: '#/components/schemas/AccountFrozenError' },
                  ],
                },
              },
            },
          },
          // message-moderation-v1 (PR1): 사전 키워드 매칭 시 422.
          // body 에 카테고리/매칭 토큰 미노출 — 송신자 우회 패턴 학습 차단.
          422: {
            description: '사전 키워드 차단 (모더레이션) — code: message_blocked',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'Message contains restricted expressions' },
                    code: { type: 'string', example: 'message_blocked' },
                  },
                },
              },
            },
          },
        },
      },
    },
    // read-at-removal-list-mask sprint: PATCH /api/matches/{matchId}/messages/read 제거.
    // "읽음" 의미를 listened_at 로 일원화하면서 read_at 컬럼이 사라졌고, 일괄 read
    // 처리 동선 자체가 무의미해졌다. 메시지별 listened 마킹은 아래 listened
    // 라우트가 단일 진실원.
    '/api/matches/{matchId}/messages/{messageId}/listened': {
      post: {
        tags: ['Message'],
        summary: '메시지 음성 청취 완료 마킹 (수신자 전용, idempotent)',
        description:
          'voice-first-message-gate sprint: 수신자가 음성을 1회 끝까지 재생한 시점에 FE 가 호출. ' +
          'BE 는 messages.listened_at 를 now() 로 단 한 번만 set 하며, 이후 호출은 그대로 현재 row 반환. ' +
          'Realtime UPDATE 로 본인의 다른 기기에도 자동 전파되어 텍스트 노출이 동기화된다.',
        parameters: [
          { name: 'matchId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'messageId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: '업데이트된 (또는 이미 listened 상태인) Message row', content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } },
          403: { description: '매치 비참여자 또는 송신자 본인 호출', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: '메시지 없음 또는 매치 불일치', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    // chat-audio-async-insert sprint: /api/matches/{messageId}/retry 제거.
    // mid-session UPDATE 패턴 폐기로 retry 의 status 전이 자체가 없어졌다.
    // 실패한 메시지는 audio_url=null, audio_status='failed' 로 INSERT 되며,
    // 사용자가 동일 텍스트로 새 메시지를 보내 재시도한다.

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
