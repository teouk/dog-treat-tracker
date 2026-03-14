'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase'; // Import the client we made in Step 4
import Login from '@/components/Login';

export default function InventoryDashboard() {
  const [inventory, setInventory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const [session, setSession] = useState<any>(null);

  useEffect(() => {
    // Check current session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    // Listen for login/logout changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // IF NO SESSION, SHOW LOGIN SCREEN
  if (!session) {
    return (<Login />);
  }

  // 1. This function MUST be inside the InventoryDashboard component
  async function handleAdjustment(sku: string, currentAdj: number, change: number) {
    const { error } = await supabase
      .from('inventory')
      .update({ manual_adjustment: (currentAdj || 0) + change })
      .eq('sku', sku);

    if (error) console.error('Update failed:', error);
  }

  useEffect(() => {
    fetchInitialData();
    const channel = supabase
      .channel('inventory-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => {
        fetchInitialData();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  async function fetchInitialData() {
    const { data } = await supabase.from('inventory').select('*').order('product_name', { ascending: true });
    if (data) setInventory(data);
    setLoading(false);
  }

  async function triggerSync() {
    setLoading(true);
    await fetch('/api/sync');
    setLoading(false);
  }

  const filteredInventory = inventory.filter((item) => {
    const nameMatch = (item.product_name || '').toLowerCase().includes(searchQuery.toLowerCase());
    const skuMatch = item.sku.toLowerCase().includes(searchQuery.toLowerCase());
    return nameMatch || skuMatch;
  });

    return (
    <main className="min-h-screen bg-[#F8FAFC] p-4 md:p-8 font-sans text-slate-900">
      <div className="max-w-2xl mx-auto">
        
        {/* HEADER SECTION */}
        <header className="mb-10 flex flex-col gap-4">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
                Inventory <span className="text-blue-600">Pro</span>
              </h1>
              <p className="text-slate-500 font-medium text-sm mt-1">Glorious Treats & Chews UK</p>
            </div>

            <div className="flex items-center gap-3">
              {/* LOGOUT BUTTON */}
              <button 
                onClick={() => supabase.auth.signOut()}
                className="text-slate-400 hover:text-red-500 transition-colors p-2"
                title="Sign Out"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>

              <button 
                onClick={triggerSync} 
                className="bg-slate-900 hover:bg-slate-800 active:scale-95 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg shadow-slate-200 transition-all flex items-center gap-2"
              >
                {loading ? (
                  <span className="flex h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                ) : 'Sync Amazon'}
              </button>
            </div>
          </div>
              {inventory[0]?.last_sync_at && (
                <div className="bg-blue-50 border border-blue-100 px-3 py-2 rounded-lg flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse"></div>
                  <p className="text-[10px] text-blue-700 font-bold uppercase tracking-widest">
                    Live Sync: {new Date(inventory[0].last_sync_at).toLocaleTimeString('en-GB')}
                  </p>
                </div>
              )}
        </header>
        
        {/* SEARCH BAR */}
        <div className="mb-8 sticky top-4 z-10">
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <svg className="h-5 w-5 text-slate-400 group-focus-within:text-blue-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="text"
              placeholder="Search product name or SKU..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="block w-full pl-11 pr-4 py-3.5 bg-white border border-slate-200 rounded-2xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 shadow-sm transition-all"
            />
          </div>
        </div>

        {/* INVENTORY LIST */}
        <div className="grid gap-6">
          {filteredInventory.map((item) => {
            const totalStock = (item.amazon_fulfillable || 0) + (item.manual_adjustment || 0);
            const isLowStock = totalStock <= 10;

            return (
              <div key={item.sku} className="group bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
                <div className="p-5">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex-1">
                      <h3 className="text-lg font-bold text-slate-800 leading-tight group-hover:text-blue-600 transition-colors">
                        {item.product_name || 'Unnamed Product'}
                      </h3>
                      <p className="text-[10px] font-bold text-slate-400 mt-1 tracking-tighter uppercase">SKU: {item.sku}</p>
                      
                      {/* INBOUND STATUS BADGE */}
                      {item.amazon_inbound > 0 && (
                        <div className="mt-3 inline-flex items-center gap-1.5 bg-orange-50 border border-orange-100 px-2.5 py-1 rounded-full">
                          <span className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-bounce"></span>
                          <span className="text-[10px] font-black text-orange-700 uppercase italic">
                            {item.amazon_inbound} Arriving
                          </span>
                        </div>
                      )}
                    </div>

                    {/* TOTAL STOCK DISPLAY */}
                    <div className="text-right">
                      <div className={`text-4xl font-black tracking-tighter ${isLowStock ? 'text-red-500' : 'text-slate-900'}`}>
                        {totalStock}
                      </div>
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Avail</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-50">
                    {/* FBA ACTUALS */}
                    <div className="bg-slate-50 rounded-xl p-3">
                      <span className="block text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1 text-center">FBA Stock</span>
                      <span className="block text-xl font-bold text-slate-700 text-center">{item.amazon_fulfillable}</span>
                    </div>

                    {/* MANUAL CONTROLS */}
                    <div className="flex flex-col items-center">
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">Manual Adj</span>
                      <div className="flex items-center gap-1 w-full">
                        <button 
                          onClick={() => handleAdjustment(item.sku, item.manual_adjustment, -1)}
                          className="flex-1 bg-white border border-slate-200 h-10 rounded-lg shadow-sm hover:bg-red-50 hover:border-red-200 text-slate-600 hover:text-red-600 font-bold transition-all"
                        >
                          -
                        </button>
                        <div className="w-8 text-center font-bold text-slate-700 text-sm">
                          {item.manual_adjustment > 0 ? `+${item.manual_adjustment}` : item.manual_adjustment}
                        </div>
                        <button 
                          onClick={() => handleAdjustment(item.sku, item.manual_adjustment, 1)}
                          className="flex-1 bg-white border border-slate-200 h-10 rounded-lg shadow-sm hover:bg-green-50 hover:border-green-200 text-slate-600 hover:text-green-600 font-bold transition-all"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
