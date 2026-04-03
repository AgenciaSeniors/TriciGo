// ============================================================
// DEPRECATED — backward-compatibility alias for verify-otp
// All new code should invoke "verify-otp" directly.
// This file re-exports the same handler so existing clients
// that still call "verify-whatsapp-otp" continue to work.
// ============================================================

import '../verify-otp/index.ts';
