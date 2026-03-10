const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = 'postgresql://postgres:DL933al0THbdFuqh@db.lqaufszburqvlslpcuac.supabase.co:5432/postgres';

async function runMigration(client, file) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', file), 'utf8');
  try {
    await client.query(sql);
    console.log('✅ ' + file);
    return true;
  } catch (err) {
    const msg = err.message;
    if (msg.includes('already exists') || msg.includes('duplicate key')) {
      console.log('⚠️  ' + file + ' (some objects already existed, skipped)');
      return true;
    }
    console.log('❌ ' + file + ': ' + msg);
    return false;
  }
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to database\n');

  const migrations = [
    '00001_initial_schema.sql',
    '00002_fix_rls_recursion.sql',
    '00003_wallet_dashboard_rpcs.sql',
    '00004_feature_flags.sql',
    '00005_ride_messages.sql',
    '00006_sprint8_promo_wallet_devices.sql',
    '00007_sprint9_payment_pipeline.sql',
    '00008_wallet_recharge_requests.sql',
    '00009_user_levels_p2p.sql',
    '00010_eligibility_cancellations.sql',
    '00011_dynamic_pricing_tips.sql',
    '00012_score_matching.sql',
    '00013_fraud_wallet_freeze.sql',
  ];

  for (const file of migrations) {
    const ok = await runMigration(client, file);
    if (!ok) {
      console.log('Stopping at failed migration');
      break;
    }
  }

  await client.end();
  console.log('\nAll migrations done!');
}

main().catch(e => { console.error(e); process.exit(1); });
