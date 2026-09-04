import { syncStockToWorkbook } from './stock-sync';
import { WorkbookUnavailableError } from './store';

/**
 * Refresh the master workbook after stock has changed.
 *
 * Called from the routes that move stock — manual adjustments, pallet
 * receipts, and the Amazon/Shopify syncs — so the workbook's stock columns
 * and its TOPLAM value stay correct without anyone pressing a button. The
 * workbook holds no formulas, so nothing else would ever recompute that
 * total.
 *
 * A workbook failure must never fail the stock change that triggered it: the
 * database is the system of record and the write has already committed by the
 * time this runs. Errors come back as data for the response to carry, and are
 * logged, rather than thrown.
 */

export type AutoSyncOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'synced'; cellsWritten: number; rowsChanged: number; totalStockValue: number }
  | { status: 'failed'; error: string };

/**
 * Off by default for the Graph driver.
 *
 * Each sync is a full read-modify-write of the workbook. That is cheap
 * against a local file, but over Graph it is two transfers of the whole
 * document per adjustment, so it wants debouncing before it is switched on
 * there. Set WORKBOOK_AUTO_SYNC explicitly to override either way.
 */
function autoSyncEnabled(): boolean {
  const raw = process.env.WORKBOOK_AUTO_SYNC?.trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return (process.env.WORKBOOK_DRIVER ?? 'local').toLowerCase() === 'local';
}

export async function syncWorkbookAfterStockChange(
  reason: string,
  actor: string | null = null,
): Promise<AutoSyncOutcome> {
  if (!autoSyncEnabled()) return { status: 'skipped', reason: 'auto-sync disabled' };

  try {
    const result = await syncStockToWorkbook({ reason, actor });
    return {
      status: 'synced',
      cellsWritten: result.cellsWritten,
      rowsChanged: result.changes.length,
      totalStockValue: result.totals.totalStockValue.to,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkbookUnavailableError) {
      // Expected while the workbook is not in place; not worth a stack trace.
      console.warn(`Workbook auto-sync skipped (${reason}): ${message}`);
      return { status: 'skipped', reason: message };
    }
    console.error(`Workbook auto-sync failed (${reason}):`, message);
    return { status: 'failed', error: message };
  }
}
