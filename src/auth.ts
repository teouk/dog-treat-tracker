import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { isLoginRateLimited, recordLoginAttempt, safeEqual } from '@/lib/security';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = String(credentials?.email || '').trim().toLowerCase();
        const password = String(credentials?.password || '');

        if (!email || !password) return null;

        // Rate limit: 10 failed attempts per email per 15 minutes
        const limited = await isLoginRateLimited(email);
        if (limited) {
          // Log the throttled attempt too so a sustained brute-force extends the lockout
          await recordLoginAttempt(email, false);
          return null;
        }

        const users = [
          {
            id: '1',
            email: (process.env.AUTH_USER1_EMAIL || '').trim().toLowerCase(),
            password: process.env.AUTH_USER1_PASSWORD || '',
          },
          {
            id: '2',
            email: (process.env.AUTH_USER2_EMAIL || '').trim().toLowerCase(),
            password: process.env.AUTH_USER2_PASSWORD || '',
          },
        ];

        // Find by email first, then compare passwords in constant time
        const candidate = users.find(u => u.email === email);
        const ok = candidate ? safeEqual(candidate.password, password) : false;

        await recordLoginAttempt(email, ok);

        return ok && candidate ? { id: candidate.id, email: candidate.email } : null;
      },
    }),
  ],
  pages: { signIn: '/' },
  session: { strategy: 'jwt' },
});
