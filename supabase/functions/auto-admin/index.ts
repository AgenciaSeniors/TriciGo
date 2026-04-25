// ============================================================
// TriciGo — Auto-Admin Edge Function
// BUG-138/139/140/141 fixes (driver approval, redemption,
// stale tropipay, incident close — see RPC delegations).
// BUG-199 fix: apikey === env.SUPABASE_SERVICE_ROLE_KEY (sb_secret_*)
// to reject the leaked legacy service_role JWT in git.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

async function getConfig(supabase: ReturnType<typeof getSupabase>): Promise<Record<string, string>> {
  const { data } = await supabase.from('platform_config').select('key, value').like('key', 'auto_%');
  const config: Record<string, string> = {};
  (data ?? []).forEach((row: { key: string; value: string }) => {
    try { config[row.key] = JSON.parse(row.value); } catch { config[row.key] = row.value; }
  });
  return config;
}

function isEnabled(config: Record<string, string>, key: string): boolean {
  return config[key] === 'true' || (config[key] as unknown) === true;
}
function getNumber(config: Record<string, string>, key: string, fallback: number): number {
  const val = parseFloat(config[key]);
  return isNaN(val) ? fallback : val;
}

const REQUIRED_DOCS = ['national_id', 'drivers_license', 'vehicle_registration', 'selfie', 'vehicle_photo'];

async function autoApproveDrivers(supabase: ReturnType<typeof getSupabase>, config: Record<string, string>) {
  if (!isEnabled(config, 'auto_approve_drivers_enabled')) return { count: 0, errors: [] };
  const faceThreshold = getNumber(config, 'auto_approve_drivers_face_threshold', 80);
  let count = 0; const errors: string[] = [];
  const { data: drivers } = await supabase.from('driver_profiles').select('id, user_id').in('status', ['pending_verification', 'under_review']);
  if (!drivers?.length) return { count, errors };
  for (const driver of drivers) {
    try {
      const { data: docs } = await supabase.from('driver_documents').select('document_type, is_verified').eq('driver_id', driver.id);
      const verifiedTypes = new Set((docs ?? []).filter((d: { is_verified: boolean }) => d.is_verified).map((d: { document_type: string }) => d.document_type));
      if (!REQUIRED_DOCS.every((t) => verifiedTypes.has(t))) continue;
      const { data: selfieChecks } = await supabase.from('selfie_checks').select('face_match_score, status').eq('driver_id', driver.id).eq('status', 'passed').order('created_at', { ascending: false }).limit(1);
      const bestScore = selfieChecks?.[0]?.face_match_score ?? 0;
      if (bestScore < faceThreshold) continue;
      await supabase.from('driver_profiles').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', driver.id);
      await supabase.from('admin_actions').insert({ admin_id: SYSTEM_USER, action: 'auto_approve_driver', target_type: 'driver_profile', target_id: driver.id, new_values: { face_match_score: bestScore, auto: true } });
      if (driver.user_id) {
        const { data: devices } = await supabase.from('user_devices').select('push_token').eq('user_id', driver.user_id).not('push_token', 'is', null);
        const tokens = (devices ?? []).map((d: { push_token: string | null }) => d.push_token).filter(Boolean) as string[];
        if (tokens.length) {
          await supabase.functions.invoke('send-push', {
            body: { tokens, title: 'Cuenta aprobada', body: 'Tu cuenta de conductor ha sido aprobada.', data: { type: 'driver_status', status: 'approved' } },
          }).catch(() => {});
        }
      }
      count++;
    } catch (err) { errors.push(`Driver ${driver.id}: ${(err as Error).message}`); }
  }
  return { count, errors };
}

async function autoApproveRedemptions(supabase: ReturnType<typeof getSupabase>, config: Record<string, string>) {
  if (!isEnabled(config, 'auto_approve_redemptions_enabled')) return { count: 0, errors: [] };
  const maxTrc = getNumber(config, 'auto_approve_redemptions_max_trc', 10000);
  let count = 0; const errors: string[] = [];
  const { data: redemptions } = await supabase.from('wallet_redemptions').select('id, driver_id, amount').eq('status', 'requested').lte('amount', maxTrc);
  if (!redemptions?.length) return { count, errors };
  for (const red of redemptions) {
    try {
      const { data: profile } = await supabase.from('driver_profiles').select('status').eq('id', red.driver_id).single();
      if (profile?.status !== 'approved') continue;
      const { error } = await supabase.rpc('approve_redemption', { p_redemption_id: red.id, p_admin_id: SYSTEM_USER });
      if (error) throw error;
      await supabase.from('admin_actions').insert({ admin_id: SYSTEM_USER, action: 'auto_approve_redemption', target_type: 'wallet_redemption', target_id: red.id, new_values: { amount: red.amount, auto: true } });
      count++;
    } catch (err) { errors.push(`Redemption ${red.id}: ${(err as Error).message}`); }
  }
  return { count, errors };
}

async function autoResolveFraud(supabase: ReturnType<typeof getSupabase>, config: Record<string, string>) {
  if (!isEnabled(config, 'auto_resolve_fraud_enabled')) return { count: 0, errors: [] };
  const hours = getNumber(config, 'auto_resolve_fraud_hours', 48);
  let count = 0; const errors: string[] = [];
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data: alerts } = await supabase.from('fraud_alerts').select('id').eq('resolved', false).eq('severity', 'low').lt('created_at', cutoff);
  if (!alerts?.length) return { count, errors };
  for (const alert of alerts) {
    try {
      await supabase.from('fraud_alerts').update({ resolved: true, resolved_by: SYSTEM_USER, resolved_at: new Date().toISOString(), resolution_note: `Auto-resolved` }).eq('id', alert.id);
      await supabase.from('admin_actions').insert({ admin_id: SYSTEM_USER, action: 'auto_resolve_fraud', target_type: 'fraud_alert', target_id: alert.id, new_values: { hours_elapsed: hours, auto: true } });
      count++;
    } catch (err) { errors.push(`Fraud ${alert.id}: ${(err as Error).message}`); }
  }
  return { count, errors };
}

async function autoCloseIncidents(supabase: ReturnType<typeof getSupabase>, config: Record<string, string>) {
  if (!isEnabled(config, 'auto_close_incidents_enabled')) return { count: 0, errors: [] };
  const hours = getNumber(config, 'auto_close_incidents_hours', 24);
  let count = 0; const errors: string[] = [];
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data: incidents } = await supabase.from('incident_reports').select('id').eq('status', 'resolved').lt('resolved_at', cutoff);
  if (!incidents?.length) return { count, errors };
  for (const inc of incidents) {
    try {
      await supabase.from('incident_reports').update({ status: 'dismissed' }).eq('id', inc.id);
      await supabase.from('admin_actions').insert({ admin_id: SYSTEM_USER, action: 'auto_close_incident', target_type: 'incident_report', target_id: inc.id, new_values: { hours_after_resolved: hours, auto: true } });
      count++;
    } catch (err) { errors.push(`Incident ${inc.id}: ${(err as Error).message}`); }
  }
  return { count, errors };
}

async function autoFailStaleTropipay(supabase: ReturnType<typeof getSupabase>) {
  let count = 0; const errors: string[] = [];
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: staleRides } = await supabase.from('rides').select('id').eq('status', 'completed').eq('payment_method', 'tropipay').eq('payment_status', 'pending').lt('completed_at', cutoff);
  if (!staleRides?.length) return { count, errors };
  for (const ride of staleRides) {
    try {
      await supabase.from('rides').update({ payment_status: 'failed' }).eq('id', ride.id);
      await supabase.from('payment_intents').update({ status: 'expired' }).eq('ride_id', ride.id).eq('status', 'pending');
      await supabase.from('admin_actions').insert({ admin_id: SYSTEM_USER, action: 'auto_fail_tropipay', target_type: 'ride', target_id: ride.id, new_values: { reason: 'Payment pending >24h', auto: true } });
      count++;
    } catch (err) { errors.push(`TropiPay ${ride.id}: ${(err as Error).message}`); }
  }
  return { count, errors };
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // BUG-199: apikey vs env.SUPABASE_SERVICE_ROLE_KEY (now sb_secret_*).
  // Leaked legacy service_role JWT in git no longer matches.
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const presented = req.headers.get('apikey') ?? '';
  if (!serviceRoleKey || presented !== serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Forbidden: auto-admin is internal-only' }),
      { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const supabase = getSupabase();
  const { data: runRow } = await supabase.from('auto_admin_runs').insert({ started_at: new Date().toISOString() }).select('id').single();
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
    const allErrors = [...drivers.errors, ...redemptions.errors, ...fraud.errors, ...incidents.errors, ...tropipay.errors];
    if (runId) {
      await supabase.from('auto_admin_runs').update({ completed_at: new Date().toISOString(), drivers_approved: drivers.count, redemptions_approved: redemptions.count, fraud_resolved: fraud.count, incidents_closed: incidents.count, errors: allErrors.length > 0 ? JSON.stringify(allErrors) : '[]' }).eq('id', runId);
    }
    return new Response(JSON.stringify({ success: true, drivers_approved: drivers.count, redemptions_approved: redemptions.count, fraud_resolved: fraud.count, incidents_closed: incidents.count, errors: allErrors.length }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (err) {
    const message = (err as Error).message;
    if (runId) await supabase.from('auto_admin_runs').update({ completed_at: new Date().toISOString(), errors: JSON.stringify([message]) }).eq('id', runId);
    return new Response(JSON.stringify({ success: false, error: message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
