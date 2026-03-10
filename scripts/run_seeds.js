const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = 'postgresql://postgres:DL933al0THbdFuqh@db.lqaufszburqvlslpcuac.supabase.co:5432/postgres';

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to database\n');

  // Run seed.sql (service types, zones, pricing rules)
  const seedSql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'seed.sql'), 'utf8');
  try {
    await client.query(seedSql);
    console.log('✅ seed.sql executed');
  } catch (err) {
    if (err.message.includes('duplicate key') || err.message.includes('already exists')) {
      console.log('⚠️  seed.sql (data already existed, skipped)');
    } else {
      console.log('❌ seed.sql: ' + err.message);
    }
  }

  // Verify seed data
  const services = await client.query('SELECT slug, name_es, base_fare_cup FROM service_type_configs ORDER BY slug');
  console.log('\n=== Service Types ===');
  services.rows.forEach(r => console.log('  ' + r.slug + ' - ' + r.name_es + ' (base: ' + r.base_fare_cup + ' centavos)'));

  const zones = await client.query('SELECT name, type, surge_multiplier FROM zones ORDER BY name');
  console.log('\n=== Zones ===');
  zones.rows.forEach(r => console.log('  ' + r.name + ' (' + r.type + ', surge: ' + r.surge_multiplier + 'x)'));

  const configs = await client.query('SELECT key, value FROM platform_config ORDER BY key');
  console.log('\n=== Platform Config ===');
  configs.rows.forEach(r => console.log('  ' + r.key + ' = ' + JSON.stringify(r.value)));

  const flags = await client.query('SELECT key, value FROM feature_flags ORDER BY key');
  console.log('\n=== Feature Flags ===');
  flags.rows.forEach(r => console.log('  ' + r.key + ' = ' + r.value));

  // Check platform system user
  const platformUser = await client.query("SELECT id, full_name, role FROM users WHERE id = '00000000-0000-0000-0000-000000000001'");
  console.log('\n=== Platform System User ===');
  if (platformUser.rows.length > 0) {
    const u = platformUser.rows[0];
    console.log('  ' + u.full_name + ' (role: ' + u.role + ')');
  } else {
    console.log('  ⚠️ NOT FOUND');
  }

  // Check platform wallet
  const platformWallet = await client.query("SELECT account_type, balance, currency FROM wallet_accounts WHERE user_id = '00000000-0000-0000-0000-000000000001'");
  console.log('\n=== Platform Wallet ===');
  platformWallet.rows.forEach(r => console.log('  ' + r.account_type + ': ' + r.balance + ' ' + r.currency));

  await client.end();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
