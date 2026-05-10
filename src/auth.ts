import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize(credentials) {
        const users = [
          {
            id: '1',
            email: process.env.AUTH_USER1_EMAIL,
            password: process.env.AUTH_USER1_PASSWORD,
          },
          {
            id: '2',
            email: process.env.AUTH_USER2_EMAIL,
            password: process.env.AUTH_USER2_PASSWORD,
          },
        ];
        const user = users.find(
          (u) => u.email === credentials?.email && u.password === credentials?.password
        );
        return user ? { id: user.id, email: user.email as string } : null;
      },
    }),
  ],
  pages: { signIn: '/' },
  session: { strategy: 'jwt' },
});
