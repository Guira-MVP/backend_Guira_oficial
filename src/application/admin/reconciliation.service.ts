import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  async runReconciliation(initiatedBy: string): Promise<string> {
    const startTime = Date.now();

    // 1. Crear registro de run
    const { data: run, error: runError } = await this.supabase
      .from('reconciliation_runs')
      .insert({
        initiated_by: initiatedBy,
        run_type: 'MANUAL_FULL',
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (runError || !run)
      throw new BadRequestException(
        `No se pudo iniciar la reconciliación: ${runError?.message}`,
      );

    // 2. Obtener todos los usuarios con wallets activas
    const { data: wallets } = await this.supabase
      .from('wallets')
      .select('user_id, id')
      .eq('is_active', true);

    const discrepancies: any[] = [];
    let usersChecked = 0;

    for (const wallet of wallets ?? []) {
      try {
        // 3. Obtener todas las monedas del usuario desde balances
        const { data: userBalances } = await this.supabase
          .from('balances')
          .select('currency, amount')
          .eq('user_id', wallet.user_id);

        for (const userBalance of userBalances ?? []) {
          const currency = userBalance.currency;

          // 4. Sumar entradas del ledger para este wallet + moneda
          const { data: ledgerCredit } = await this.supabase
            .from('ledger_entries')
            .select('amount')
            .eq('wallet_id', wallet.id)
            .eq('currency', currency)
            .eq('type', 'credit')
            .eq('status', 'settled');

          const { data: ledgerDebit } = await this.supabase
            .from('ledger_entries')
            .select('amount')
            .eq('wallet_id', wallet.id)
            .eq('currency', currency)
            .eq('type', 'debit')
            .eq('status', 'settled');

          const creditSum =
            ledgerCredit?.reduce((acc, curr) => acc + Number(curr.amount), 0) ?? 0;
          const debitSum =
            ledgerDebit?.reduce((acc, curr) => acc + Number(curr.amount), 0) ?? 0;
          const ledgerTotal = creditSum - debitSum;
          const balanceTotal = Number(userBalance.amount);

          // Tolerancia a centavos de float math
          if (Math.abs(ledgerTotal - balanceTotal) > 0.01) {
            discrepancies.push({
              user_id: wallet.user_id,
              wallet_id: wallet.id,
              currency,
              ledger_total: ledgerTotal,
              balance_total: balanceTotal,
              difference: ledgerTotal - balanceTotal,
            });
          }
        }
        usersChecked++;
      } catch (err) {
        console.error(`Error reconciliando wallet ${wallet.id}: ${err}`);
      }
    }

    // 5. Actualizar resultado
    await this.supabase
      .from('reconciliation_runs')
      .update({
        status: 'completed',
        users_checked: usersChecked,
        discrepancies_found: discrepancies.length,
        discrepancies_detail: discrepancies.length > 0 ? discrepancies : null,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        requires_manual_review: discrepancies.length > 0,
      })
      .eq('id', run.id);

    return run.id;
  }

  async getReconciliationHistory(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const { data, count, error } = await this.supabase
      .from('reconciliation_runs')
      .select('*', { count: 'exact' })
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throwDbError(error);
    return { data, total: count, page, limit };
  }

  async getReconciliationDetail(runId: string) {
    const { data, error } = await this.supabase
      .from('reconciliation_runs')
      .select('*')
      .eq('id', runId)
      .single();

    if (error || !data)
      throw new BadRequestException('Reconciliación no encontrada');
    return data;
  }
}
