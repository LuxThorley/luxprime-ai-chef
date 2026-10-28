# Two-factor authentication: set-up and admin recovery

## Configuration
- Worker secret **`TOTP_ENC_KEY`** (≥16 chars; use 32+ random bytes, e.g. `openssl rand -base64 32`), set with
  `npx wrangler secret put TOTP_ENC_KEY` in `worker/`. Without it, 2FA is dormant (set-up returns 503, nothing is enforced).
- Changing or losing `TOTP_ENC_KEY` makes every stored authenticator secret unreadable: everyone with 2FA must be reset (below).
- Admin (`ADMIN_EMAILS`) and tester (`TESTER_EMAILS`) accounts must enrol: after signing in they can only reach `/api/me`,
  `/api/csrf`, logout and the 2FA set-up endpoints until it's on.

## Member lost their phone
1. They sign in with one of their 10 backup codes (each works once), then turn 2FA off and on again, or make new backup codes.
2. No backup codes: verify identity out of band (reply from the account email), then an operator resets 2FA (below).

## Operator reset for one account (D1, via the Cloudflare connector or `wrangler d1 execute ... --remote`; a live change, so needs Oliver's YES)
```sql
DELETE FROM user_totp WHERE user_id = ?;
DELETE FROM totp_backup_codes WHERE user_id = ?;
DELETE FROM trusted_devices WHERE user_id = ?;
DELETE FROM login_challenges WHERE user_id = ?;
DELETE FROM sessions WHERE user_id = ?;   -- sign out everywhere
```
For an admin/tester, they're asked to enrol again on their next sign-in.

## Admin locked out completely (own account)
Use the reset above on your own user id via the Cloudflare dashboard D1 console (Cloudflare login has its own 2FA, so keep that on).
Emergency switch: removing the `TOTP_ENC_KEY` secret disables 2FA checks site-wide (sign-in falls back to password only) — use only briefly and restore the same value afterwards.

## Revoke trusted devices
Member: Account → Security → "Forget all trusted devices". Operator: `DELETE FROM trusted_devices WHERE user_id = ?;`
