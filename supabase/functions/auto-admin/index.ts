// ============================================================
// TriciGo — Auto-Admin Edge Function
// Runs every 5 minutes via pg_cron to automate repetitive admin
// tasks: driver approval, wallet redemptions, fraud alerts,
// incident closure. All configurable via platform_config.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const SYSTEM_USER = '00000000-0000-0000-0000-000000000001';

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function getSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

// ── Config helpers ──

async function getConfig(supabase: ReturnType<typeof getSupabase>): Promise<Record<string, string>> {
  const { data } = await supabase
    .from('platform_config')
    .select('key, value')
    .like('key', 'auto_%');
  const config: Record<string, string> = {};
  (data ?? []).forEach((row: { key: string; value: string }) => {
    // value is stored as JSON string, e.g. '"true"' or '"80"'
    try {
      config[row.key] = JSON.parse(row.value);
    } catch {
      config[row.key] = row.value;
    }
  });
  return config;
}

function isEnabled(config: Record<string, string>, key: string): boolean {
  return config[key] === 'true' || config[key] === true as unknown as string;
}

function getNumber(config: Record<string, string>, key: string, fallback: number): number {
  const val = parseFloat(config[key]);
  return isNaN(val) ? fallback : val;
}

// ── Required document types ──
const REQUIRED_DOCS = ['national_id', 'drivers_license', 'vehicle_registration', 'selfie', 'vehicle_photo'];

// ── Task A: Auto-approve drivers ──

async function autoApproveDrivers(
  supabase: ReturnType<typeof getSupabase>,
  config: Record<string, string>,
): Promise<{ count: number; errors: string[] }> {
  if (!isEnabled(config, 'auto_approve_drivers_enabled')) return { count: 0, errors: [] };

  const faceThreshold = getNumber(config, 'auto_approve_drivers_face_threshold', 80);
  let count = 0;
  const errors: string[] = [];

  // Get drivers pending verification or under review
  const { data: drivers } = await supabase
    .from('driver_profiles')
    .select('id, user_id')
    .in('status', ['pending_verification', 'under_review']);

  if (!drivers?.length) return { count, errors };

  for (const driver of drivers) {
    try {
      // Check all 5 required docs are verified
      const { data: docs } = await supabase
        .from('driver_documents')
        .select('document_type, is_verified')
        .eq('driver_id', driver.id);

      const verifiedTypes = new Set(
        (docs ?? [])
          .filter((d: { is_verified: boolean }) => d.is_verified)
          .map((d: { document_type: string }) => d.document_type),
      );

      const allDocsVerified = REQUIRED_DOCS.every((t) => verifiedTypes.has(t));
      if (!allDocsVerified) continue;

      // Check face match score
      const { data: selfieChecks } = await supabase
        .from('selfie_checks')
        .select('face_match_score, status')
        .eq('driver_id', driver.id)
        .eq('status', 'passed')
        .order('created_at', { ascending: false })
        .limit(1);

      const bestScore = selfieChecks?.[0]?.face_match_score ?? 0;
      if (bestScore < faceThreshold) continue;

      // Auto-approve
      await supabase
        .from('driver_profiles')
        .update({ status: 'approved', approved_at: new Date().toISOString() })
        .eq('id', driver.id);

      // Log action
      await supabase.from('admin_actions').insert({
        admin_id: SYSTEM_USER,
        action: 'auto_approve_driver',
        target_type: 'driver_profile',
        target_id: driver.id,
        details: JSON.stringify({ face_match_score: bestScore, auto: true }),
      });

      // Send push notification
      if (driver.user_id) {
        const { data: tokens } = await supabase
          .from('device_tokens')
          .select('token')
          .eq('user_id', driver.user_id);
        if (tokens?.length) {
          await supabase.functions.invoke('send-push', {
            body: {
              tokens: tokens.map((t: { token: string }) => t.token),
              title: 'Cuenta aprobada',
              body: 'Tu cuenta de conductor ha sido aprobada. Ya puedes empezar a recibir viajes.',
              data: { type: 'driver_status', status: 'approved' },
            },
          }).catch(() => {});
        }
      }

      count++;
    } catch (err) {
      errors.push(`Driver ${driver.id}: ${(err as Error).message}`);
    }
  }

  return { count, errors };
}

// ── Task B: Auto-approve small redemptions ──

async function autoApproveRedemptions(
  supabase: ReturnType<typeof getSupabase>,
  config: Record<string, string>,
): Promise<{ count: number; errors: string[] }> {
  if (!isEnabled(config, 'auto_approve_redemptions_enabled')) return { count: 0, errors: [] };

  const maxTrc = getNumber(config, 'auto_approve_redemptions_max_trc', 10000);
  let count = 0;
  const errors: string[] = [];

  const { data: redemptions } = await supabase
    .from('wallet_redemptions')
    .select('id, driver_id, amount')
    .eq('status', 'requested')
    .lte('amount', maxTrc);

  if (!redemptions?.length) return { count, errors };

  for (const red of redemptions) {
    try {
      // Verify driver is approved
      const { data: profile } = await supabase
        .from('driver_profiles')
        .select('status')
        .eq('id', red.driver_id)
        .single();

      if (profile?.status !== 'approved') continue;

      // Approve the redemption
      await supabase
        .from('wallet_redemptions')
        .update({
          status: 'approved',
          processed_at: new Date().toISOString(),
          processed_by: SYSTEM_USER,
        })
        .eq('id', red.id);

      // Log action
      await supabase.from('admin_actions').insert({
        admin_id: SYSTEM_USER,
        action: 'auto_approve_redemption',
        target_type: 'wallet_redemption',
        target_id: red.id,
        details: JSON.stringify({ amount: red.amount, auto: true }),
      });

      count++;
    } catch (err) {
      errors.push(`Redemption ${red.id}: ${(err as Error).message}`);
    }
  }

  return { count, errors };
}

// ── Task C: Auto-resolve low-severity fraud alerts ──

async function autoResolveFraud(
  supabase: ReturnType<typeof getSupabase>,
  config: Record<string, string>,
): Promise<{ count: number; errors: string[] }> {
  if (!isEnabled(config, 'auto_resolve_fraud_enabled')) return { count: 0, errors: [] };

  const hours = getNumber(config, 'auto_resolve_fraud_hours', 48);
  let count = 0;
  const errors: string[] = [];

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data: alerts } = await supabase
    .from('fraud_alerts')
    .select('id')
    .eq('resolved', false)
    .eq('severity', 'low')
    .lt('created_at', cutoff);

  if (!alerts?.length) return { count, errors };

  for (const alert of alerts) {
    try {
      await supabase
        .from('fraud_alerts')
        .update({
          resolved: true,
          resolved_by: SYSTEM_USER,
          resolved_at: new Date().toISOString(),
          resolution_note: `Auto-resolved: low severity, no action after ${hours}h`,
        })
        .eq('id', alert.id);

      await supabase.from('admin_actions').insert({
        admin_id: SYSTEM_USER,
        action: 'auto_resolve_fraud',
        target_type: 'fraud_alert',
        target_id: alert.id,
        details: JSON.stringify({ hours_elapsed: hours, auto: true }),
      });

      count++;
    } catch (err) {
      errors.push(`Fraud ${alert.id}: ${(err as Error).message}`);
    }
  }

  return { count, errors };
}

// ── Task D: Auto-close resolved incidents ──

async function autoCloseIncidents(
  supabase: ReturnType<typeof getSupabase>,
  config: Record<string, string>,
): Promise<{ count: number; errors: string[] }> {
  if (!isEnabled(config, 'auto_close_incidents_enabled')) return { count: 0, errors: [] };

  const hours = getNumber(config, 'auto_close_incidents_hours', 24);
  let count = 0;
  const errors: string[] = [];

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data: incidents } = await supabase
    .from('incidents')
    .select('id')
    .eq('status', 'resolved')
    .lt('resolved_at', cutoff);

  if (!incidents?.length) return { count, errors };

  for (const inc of incidents) {
    try {
      await supabase
        .from('incidents')
        .update({ status: 'dismissed' })
        .eq('id', inc.id);

      await supabase.from('admin_actions').insert({
        admin_id: SYSTEM_USER,
        action: 'auto_close_incident',
        target_type: 'incident',
        target_id: inc.id,
        details: JSON.stringify({ hours_after_resolved: hours, auto: true }),
      });

      count++;
    } catch (err) {
      errors.push(`Incident ${inc.id}: ${(err as Error).message}`);
    }
  }

  return { count, errors };
}

// ── Task E: Auto-fail stale TropiPay payments ──

async function autoFailStaleTropipay(
  supabase: ReturnType<typeof getSupabase>,
): Promise<{ count: number; errors: string[] }> {
  let count = 0;
  const errors: string[] = [];

  // Find rides with pending TropiPay payments older than 24 hours
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: staleRides } = await supabase
    .from('rides')
    .select('id')
    .eq('status', 'completed')
    .eq('payment_method', 'tropipay')
    .eq('payment_status', 'pending')
    .lt('completed_at', cutoff);

  if (!staleRides?.length) return { count, errors };

  for (const ride of staleRides) {
    try {
      await supabase
        .from('rides')
        .update({ payment_status: 'failed' })
        .eq('id', ride.id);

      // Also mark any payment intent as expired
      await supabase
        .from('payment_intents')
        .update({ status: 'expired' })
        .eq('reference_id', ride.id)
        .eq('status', 'pending');

      await supabase.from('admin_actions').insert({
        admin_id: SYSTEM_USER,
        action: 'auto_fail_tropipay',
        target_type: 'ride',
        target_id: ride.id,
        details: JSON.stringify({ reason: 'Payment pending >24h', auto: true }),
      });

      count++;
    } catch (err) {
      errors.push(`TropiPay ${ride.id}: ${(err as Error).message}`);
    }
  }

  return { count, errors };
}

// ── Main handler ──

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  const supabase = getSupabase();

  // Create run log
  const { data: runRow } = await supabase
    .from('auto_admin_runs')
    .insert({ started_at: new Date().toISOString() })
    .select('id')
    .single();

  const runId = runRow?.id;

  try {
    const config = await getConfig(supabase);

    const [drivers, redemptions, fraud, incidents, tropipay] = await Promise.all([
      autoApproveDrivers(supabase, config),
      autoApproveRedemptions(supabase, config),
      autoResolveFraud(supabase, config),
      autoCloseIncidents(supabase, config),
      autoFailStaleTropipay(supabase),
    ]);

    const allErrors = [
      ...drivers.errors,
      ...redemptions.errors,
      ...fraud.errors,
      ...incidents.errors,
      ...tropipay.errors,
    ];

    // Update run log
    if (runId) {
      await supabase
        .from('auto_admin_runs')
        .update({
          completed_at: new Date().toISOString(),
          drivers_approved: drivers.count,
          redemptions_approved: redemptions.count,
          fraud_resolved: fraud.count,
          incidents_closed: incidents.count,
          errors: allErrors.length > 0 ? JSON.stringify(allErrors) : '[]',
        })
        .eq('id', runId);
    }

    const summary = {
      success: true,
      drivers_approved: drivers.count,
      redemptions_approved: redemptions.count,
      fraud_resolved: fraud.count,
      incidents_closed: incidents.count,
      errors: allErrors.length,
    };

    console.log('Auto-admin completed:', JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error('Auto-admin error:', message);

    if (runId) {
      await supabase
        .from('auto_admin_runs')
        .update({
          completed_at: new Date().toISOString(),
          errors: JSON.stringify([message]),
        })
        .eq('id', runId);
    }

    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
