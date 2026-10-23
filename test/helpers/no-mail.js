'use strict'; // Tests must never reach a real mail provider, even if the shell has a key exported.
delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM; delete process.env.MAGAZINE_FROM;
