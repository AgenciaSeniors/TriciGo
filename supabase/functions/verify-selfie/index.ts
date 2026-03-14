// supabase/functions/verify-selfie/index.ts
// Processes a selfie check: compares submitted selfie against onboarding selfie.
// MVP: placeholder scoring. Replace with AWS Rekognition / Google Vision for production.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MATCH_THRESHOLD = 0.80;

interface VerifyRequest {
  check_id: string;
  driver_id: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { check_id, driver_id } = (await req.json()) as VerifyRequest;

    if (!check_id || !driver_id) {
      return new Response(
        JSON.stringify({ error: 'check_id and driver_id are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 1. Fetch the selfie check record
    const { data: check, error: checkError } = await supabase
      .from('selfie_checks')
      .select('*')
      .eq('id', check_id)
      .single();

    if (checkError || !check) {
      return new Response(
        JSON.stringify({ error: 'Selfie check not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 2. Fetch the onboarding selfie for comparison
    const { data: onboardingSelfie } = await supabase
      .from('driver_documents')
      .select('storage_path')
      .eq('driver_id', driver_id)
      .eq('document_type', 'selfie')
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .single();

    if (!onboardingSelfie) {
      // No onboarding selfie to compare against — fail the check
      await supabase
        .from('selfie_checks')
        .update({
          status: 'failed',
          face_match_score: 0,
          liveness_passed: false,
          completed_at: new Date().toISOString(),
        })
        .eq('id', check_id);

      return new Response(
        JSON.stringify({ status: 'failed', reason: 'No onboarding selfie found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 3. Face comparison
    // MVP PLACEHOLDER: Generate a realistic score.
    // In production, download both images from storage and send to face comparison API:
    //   - AWS Rekognition CompareFaces
    //   - Google Cloud Vision face detection
    //   - Azure Face API
    //
    // const checkImageUrl = supabase.storage.from('driver-documents').getPublicUrl(check.storage_path);
    // const refImageUrl = supabase.storage.from('driver-documents').getPublicUrl(onboardingSelfie.storage_path);
    // const result = await faceComparisonApi.compare(checkImageUrl, refImageUrl);

    const faceMatchScore = 0.85 + Math.random() * 0.15; // MVP: 0.85-1.0
    const livenessScore = Math.random() > 0.05; // MVP: 95% pass rate
    const passed = faceMatchScore >= MATCH_THRESHOLD && livenessScore;

    // 4. Update the check record
    const { error: updateError } = await supabase
      .from('selfie_checks')
      .update({
        status: passed ? 'passed' : 'failed',
        face_match_score: Math.round(faceMatchScore * 100) / 100,
        liveness_passed: livenessScore,
        completed_at: new Date().toISOString(),
      })
      .eq('id', check_id);

    if (updateError) {
      console.error('Failed to update selfie check:', updateError);
    }

    return new Response(
      JSON.stringify({
        status: passed ? 'passed' : 'failed',
        face_match_score: Math.round(faceMatchScore * 100) / 100,
        liveness_passed: livenessScore,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('verify-selfie error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
