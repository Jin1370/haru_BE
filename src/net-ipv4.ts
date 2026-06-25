// Force outbound DNS resolution to prefer IPv4 (A records) over IPv6 (AAAA).
//
// Fly.io machines are IPv6-first. The IPv6 egress path from Fly (nrt/Tokyo) to
// googleapis.com drops the connection mid-response — gaxios/node-fetch surface
// it as `FetchError: ... oauth2/v4/token: Premature close`
// (ERR_STREAM_PREMATURE_CLOSE). That kills the Vertex AI OAuth token fetch, so
// every message translation/TTS fails (messages.audio_status='failed') and the
// recipient never sees the message (voice-first gate hides non-'ready' audio).
// Preferring IPv4 avoids the broken v6 path.
//
// Imported FIRST in index.ts so it applies before any module performs outbound
// HTTPS. Harmless on networks where IPv6 works (IPv4 is simply tried first).
import { setDefaultResultOrder } from 'node:dns';

setDefaultResultOrder('ipv4first');
