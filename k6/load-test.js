import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Config ──
const SUPABASE_URL = 'https://lqaufszburqvlslpcuac.supabase.co';
const ANON_KEY = 'sb_publishable_hSzDS_2ivar8CGqUm-yd3w_-65h1Zsc';

const headers = {
  'Content-Type': 'application/json',
  'apikey': ANON_KEY,
  'Authorization': `Bearer ${ANON_KEY}`,
};

// ── Metrics ──
const errorRate = new Rate('errors');
const fareEstimateTime = new Trend('fare_estimate_time');
const searchingRidesTime = new Trend('searching_rides_time');
const pricingRulesTime = new Trend('pricing_rules_time');
const serviceConfigsTime = new Trend('service_configs_time');
const surgeCalcTime = new Trend('surge_calc_time');

// ── Test Options ──
export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Ramp up to 10 users
    { duration: '1m', target: 50 },     // Ramp up to 50 users
    { duration: '2m', target: 100 },    // Hold at 100 users
    { duration: '30s', target: 0 },     // Ramp down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<2000'],  // 95% of requests under 2s
    'errors': ['rate<0.05'],              // Error rate under 5%
  },
};

// ── Test Scenarios ──

export default function () {
  // 1. Fetch service configs (every user on app open)
  const configRes = http.get(
    `${SUPABASE_URL}/rest/v1/service_type_configs?select=*&is_active=eq.true`,
    { headers, tags: { name: 'service_configs' } },
  );
  serviceConfigsTime.add(configRes.timings.duration);
  check(configRes, { 'service_configs 200': (r) => r.status === 200 });
  errorRate.add(configRes.status !== 200);

  sleep(0.5);

  // 2. Fetch pricing rules (on estimate request)
  const pricingRes = http.get(
    `${SUPABASE_URL}/rest/v1/pricing_rules?select=*&is_active=eq.true`,
    { headers, tags: { name: 'pricing_rules' } },
  );
  pricingRulesTime.add(pricingRes.timings.duration);
  check(pricingRes, { 'pricing_rules 200': (r) => r.status === 200 });
  errorRate.add(pricingRes.status !== 200);

  sleep(0.5);

  // 3. Calculate surge (RPC call)
  const surgeRes = http.post(
    `${SUPABASE_URL}/rest/v1/rpc/calculate_dynamic_surge`,
    JSON.stringify({
      p_lat: 23.13,
      p_lng: -82.38,
      p_service_type: 'triciclo_basico',
    }),
    { headers, tags: { name: 'calculate_surge' } },
  );
  surgeCalcTime.add(surgeRes.timings.duration);
  check(surgeRes, { 'surge_calc 200': (r) => r.status === 200 });
  errorRate.add(surgeRes.status !== 200);

  sleep(0.5);

  // 4. Get searching rides (driver polling)
  const searchRes = http.get(
    `${SUPABASE_URL}/rest/v1/rides?select=*&status=eq.searching&order=created_at.desc&limit=20`,
    { headers, tags: { name: 'searching_rides' } },
  );
  searchingRidesTime.add(searchRes.timings.duration);
  check(searchRes, { 'searching_rides 200': (r) => r.status === 200 });
  errorRate.add(searchRes.status !== 200);

  sleep(0.5);

  // 5. Get exchange rate (wallet/pricing)
  const rateRes = http.get(
    `${SUPABASE_URL}/rest/v1/platform_config?select=value&key=eq.exchange_rate_cup_usd`,
    { headers, tags: { name: 'exchange_rate' } },
  );
  check(rateRes, { 'exchange_rate 200': (r) => r.status === 200 });
  errorRate.add(rateRes.status !== 200);

  sleep(0.5);

  // 6. Health check (monitoring)
  const healthRes = http.get(
    `${SUPABASE_URL}/functions/v1/health-check`,
    { headers: { ...headers, 'Authorization': `Bearer ${ANON_KEY}` }, tags: { name: 'health_check' } },
  );
  check(healthRes, { 'health 200': (r) => r.status === 200 || r.status === 401 });

  sleep(1);
}
