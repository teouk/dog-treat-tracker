'use client';
import { useState } from 'react';
import { signIn } from 'next-auth/react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const result = await signIn('credentials', { email, password, redirect: false });
    if (result?.error) setError('Invalid email or password.');
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-slate-200 p-8">
        <h1 className="text-2xl font-black text-slate-900 mb-2 text-center">Treat Tracker <span className="text-blue-600">Pro</span></h1>
        <p className="text-slate-500 text-center mb-8 text-sm font-medium">Please sign in to view UK inventory</p>

        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="email" placeholder="Email Address"
            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
            onChange={(e) => setEmail(e.target.value)} required
          />
          <input
            type="password" placeholder="Password"
            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
            onChange={(e) => setPassword(e.target.value)} required
          />
          {error && <p className="text-red-500 text-sm text-center">{error}</p>}
          <button
            disabled={loading}
            className="w-full bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-slate-800 transition-all shadow-lg disabled:opacity-50"
          >
            {loading ? 'Authenticating...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}