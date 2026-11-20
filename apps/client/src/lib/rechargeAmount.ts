/**
 * The amount the recharge sheet opens with: the smallest preset the minimum
 * allows, so its chip is marked and "Pagar con tarjeta" is enabled from the
 * start. The sheet used to open empty with a grey "20" placeholder that looked
 * like a chosen amount while the button stayed disabled (QA R2-10).
 */
export function defaultRechargeAmountUsd(presetsUsd: readonly number[], minUsd: number): string {
  const preset = [...presetsUsd].sort((a, b) => a - b).find((amount) => amount >= minUsd);
  return String(preset ?? minUsd);
}
