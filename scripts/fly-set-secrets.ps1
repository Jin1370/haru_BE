# Fly secrets 일괄 설정 — .env + credentials/*.json 을 읽어 fly secrets set 호출.
#
# 동작:
#   1) haru_BE/.env 에서 키-값 파싱
#   2) GOOGLE_APPLICATION_CREDENTIALS 경로의 JSON 읽어 compact 한 줄로 변환
#   3) fly secrets set 호출 (한 번에 모든 키 설정 → 한 번만 deploy 트리거)
#
# 사용:
#   cd haru_BE
#   .\scripts\fly-set-secrets.ps1
#
# 옵션:
#   $env:ADMIN_VERCEL_URL = 'https://haruadmin.vercel.app'   # CORS allowed origin override
#
# 출시 시 ADMIN_DASHBOARD_ENABLED 만 끄려면:
#   fly secrets set ADMIN_DASHBOARD_ENABLED=false

$ErrorActionPreference = 'Stop'

$beRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $beRoot '.env'

if (-not (Test-Path $envFile)) {
  Write-Error ".env 부재: $envFile"
  exit 1
}

# .env 파싱 — 단순 KEY=VALUE 매처. 따옴표 둘러싼 값은 벗김.
$envVars = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') {
    $key = $Matches[1]
    $val = $Matches[2].Trim()
    if ($val -match '^"(.*)"$') { $val = $Matches[1] }
    elseif ($val -match "^'(.*)'$") { $val = $Matches[1] }
    $envVars[$key] = $val
  }
}

# GCP 서비스 계정 JSON 경로 해석
$gcpRelPath = $envVars['GOOGLE_APPLICATION_CREDENTIALS']
if (-not $gcpRelPath) {
  Write-Error '.env 에 GOOGLE_APPLICATION_CREDENTIALS 없음'
  exit 1
}
$gcpPath = if ([System.IO.Path]::IsPathRooted($gcpRelPath)) {
  $gcpRelPath
} else {
  Join-Path $beRoot $gcpRelPath
}
if (-not (Test-Path $gcpPath)) {
  Write-Error "GCP service account JSON 부재: $gcpPath"
  exit 1
}

# Base64 인코딩 — Windows PowerShell argv 의 따옴표/이스케이프 이슈 회피.
# BE 의 env.ts 는 GOOGLE_APPLICATION_CREDENTIALS_JSON_B64 를 우선 디코드해 사용.
$gcpJsonText = Get-Content -Raw $gcpPath
$gcpJsonB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($gcpJsonText))

# CORS allowed origin
$corsOrigins = if ($env:ADMIN_VERCEL_URL) { $env:ADMIN_VERCEL_URL } else { 'https://haruadmin.vercel.app' }

# GCP_LOCATION 폴백
$gcpLocation = if ($envVars['GCP_LOCATION']) { $envVars['GCP_LOCATION'] } else { 'us-central1' }

# 필수 키 검증
$requiredKeys = @(
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_JWT_SECRET',
  'ELEVENLABS_API_KEY', 'GCP_PROJECT_ID', 'ADMIN_SECRET'
)
foreach ($k in $requiredKeys) {
  if (-not $envVars[$k]) {
    Write-Error ".env 에 $k 가 비어있음"
    exit 1
  }
}

# fly secrets set 인자 구성 — 각 원소가 KEY=VALUE 하나
$secretArgs = @(
  "SUPABASE_URL=$($envVars['SUPABASE_URL'])"
  "SUPABASE_SERVICE_ROLE_KEY=$($envVars['SUPABASE_SERVICE_ROLE_KEY'])"
  "SUPABASE_ANON_KEY=$($envVars['SUPABASE_ANON_KEY'])"
  "SUPABASE_JWT_SECRET=$($envVars['SUPABASE_JWT_SECRET'])"
  "ELEVENLABS_API_KEY=$($envVars['ELEVENLABS_API_KEY'])"
  "GCP_PROJECT_ID=$($envVars['GCP_PROJECT_ID'])"
  "GCP_LOCATION=$gcpLocation"
  "GOOGLE_APPLICATION_CREDENTIALS_JSON_B64=$gcpJsonB64"
  "NODE_ENV=production"
  "ADMIN_DASHBOARD_ENABLED=true"
  "ADMIN_SECRET=$($envVars['ADMIN_SECRET'])"
  "CORS_ALLOWED_ORIGINS=$corsOrigins"
)

Write-Host ""
Write-Host "=== Fly secrets 설정 예정 ===" -ForegroundColor Cyan
foreach ($a in $secretArgs) {
  $key = ($a -split '=', 2)[0]
  $valLen = ($a -split '=', 2)[1].Length
  Write-Host ("  {0,-40} ({1} chars)" -f $key, $valLen)
}
Write-Host ""

# fly 바이너리 위치 (PATH 인식 안 될 수도 있어 full path 사용)
$flyExe = "$env:USERPROFILE\.fly\bin\fly.exe"
if (-not (Test-Path $flyExe)) {
  Write-Error "fly.exe 부재: $flyExe — flyctl 설치 확인"
  exit 1
}

Write-Host "=== fly secrets set 실행 중... ===" -ForegroundColor Cyan
& $flyExe secrets set @secretArgs
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
  Write-Host ""
  Write-Host "✓ 모든 secrets 설정 완료" -ForegroundColor Green
  Write-Host "다음 단계: fly deploy"
} else {
  Write-Host ""
  Write-Host "✗ fly secrets set 실패 (exit $exitCode)" -ForegroundColor Red
  exit $exitCode
}
