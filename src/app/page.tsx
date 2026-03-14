'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import Login from '@/components/Login';

export default function InventoryDashboard() {
  const [inventory, setInventory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [session, setSession] = useState<any>(null);
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    supabase.auth.onAuthStateChange((_event, session) => setSession(session));
    fetchInitialData();
  }, []);

  async function fetchInitialData() {
    const { data } = await supabase.from('inventory').select('*').order('product_name', { ascending: true });
    if (data) setInventory(data);
  }

  // --- THE NEW 3-STEP SYNC ---
  async function triggerSync() {
    setLoading(true);
    setSyncStatus('Requesting Report...');
    try {
      const start = await fetch('/api/sync/start').then(res => res.json());
      
      let ready = false;
      let docId = '';
      for (let i = 0; i < 10; i++) {
        setSyncStatus(`Amazon is thinking... (${i+1}/10)`);
        await new Promise(r => setTimeout(r, 3000));
        const check = await fetch(`/api/sync/check?reportId=${start.reportId}`).then(res => res.json());
        if (check.ready) {
          ready = true;
          docId = check.reportDocumentId;
          break;
        }
      }

      if (ready) {
        setSyncStatus('Downloading Data...');
        await fetch(`/api/sync/download?reportDocumentId=${docId}`);
        await fetchInitialData();
        setSyncStatus('');
      } else {
        alert("Amazon is busy. Try again in 2 minutes.");
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }

  async function adjustShopStock(sku: string, current: number, change: number) {
    await supabase.from('inventory').update({ shop_stock: (current || 0) + change }).eq('sku', sku);
    fetchInitialData();
  }

  if (!hasMounted) return null;
  if (!session) return <Login />;

  const filtered = inventory.filter(i => 
    (i.product_name || '').toLowerCase().includes(searchQuery.toLowerCase()) || 
    i.sku.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <main className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans">
      <div className="max-w-2xl mx-auto">
        <header className="mb-8 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-black italic">TREAT TRACKER <span className="text-blue-600">PRO</span></h1>
            <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">{syncStatus || 'Ready'}</p>
          </div>
          <button onClick={triggerSync} disabled={loading} className="bg-slate-900 text-white px-6 py-2 rounded-xl font-bold text-sm shadow-lg disabled:opacity-50">
            {loading ? 'Syncing...' : 'Sync Amazon'}
          </button>
        </header>

        <input 
          type="text" placeholder="Search treats..." 
          className="w-full p-4 rounded-2xl border border-slate-200 mb-6 outline-none focus:ring-2 focus:ring-blue-500"
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div className="grid gap-4">
          {filtered.map(item => {
            const total = (item.fba_quantity || 0) + (item.fbm_quantity || 0) + (item.shop_stock || 0);
            return (
              <div key={item.sku} className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm">
                <div className="flex justify-between items-start mb-4">
                  <div className="max-w-[70%]">
                    <h3 className="font-black text-slate-800 leading-tight">{item.product_name}</h3>
                    <p className="text-[10px] text-slate-400 font-bold mt-1">SKU: {item.sku}</p>
                  </div>
                  <div className="text-right">
                    <span className={`text-3xl font-black ${total <= 5 ? 'text-red-500' : 'text-slate-900'}`}>{total}</span>
                    <p className="text-[8px] font-black text-slate-400 uppercase">Total</p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center border-t border-slate-50 pt-4">
                  <div className="bg-orange-50 p-2 rounded-xl">
                    <span className="block text-[8px] font-black text-orange-400 uppercase">FBA</span>
                    <span className="font-bold text-orange-700">{item.fba_quantity || 0}</span>
                  </div>
                  <div className="bg-blue-50 p-2 rounded-xl">
                    <span className="block text-[8px] font-black text-blue-400 uppercase">FBM</span>
                    <span className="font-bold text-blue-700">{item.fbm_quantity || 0}</span>
                  </div>
                  <div className="bg-green-50 p-2 rounded-xl relative">
                    <span className="block text-[8px] font-black text-green-400 uppercase">Shop</span>
                    <span className="font-bold text-green-700">{item.shop_stock || 0}</span>
                    <div className="flex justify-center gap-2 mt-2">
                      <button onClick={() => adjustShopStock(item.sku, item.shop_stock, -1)} className="w-6 h-6 bg-white border border-green-200 rounded-md text-green-600 font-bold">-</button>
                      <button onClick={() => adjustShopStock(item.sku, item.shop_stock, 1)} className="w-6 h-6 bg-white border border-green-200 rounded-md text-green-600 font-bold">+</button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </main>
  );
}