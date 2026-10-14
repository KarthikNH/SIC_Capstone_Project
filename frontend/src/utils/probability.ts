// Canonical utility for probability, percent, branch formatting, and outcome categorization

export function assertNotNaN(val: unknown, label = 'number'): void {
  if (typeof val === 'number' && (isNaN(val) || !isFinite(val))) {
    console.error(`[DevAssertion] NaN or Inf detected for ${label}:`, val);
  }
}

// Canonical alert threshold across entire UI (35%)
export const CANONICAL_ALERT_THRESHOLD = 0.35;

/**
 * Format probability (0.0 to 1.0) into a clean percentage string.
 * Never multiplies or divides inside components.
 */
export function formatProbability(p: number | undefined | null, decimals = 1): string {
  if (p === null || p === undefined || typeof p !== 'number' || isNaN(p) || !isFinite(p)) {
    return 'Unavailable';
  }
  assertNotNaN(p, 'probability');
  const pct = Math.max(0, Math.min(100, p * 100));
  return `${pct.toFixed(decimals)}%`;
}

/**
 * Format percent value (0 to 100) into a clean percentage string.
 */
export function formatPercent(p: number | undefined | null, decimals = 1): string {
  if (p === null || p === undefined || typeof p !== 'number' || isNaN(p) || !isFinite(p)) {
    return '0.0%';
  }
  assertNotNaN(p, 'percent');
  return `${p.toFixed(decimals)}%`;
}

/**
 * Format 1-based IEEE branch name: "Line 3-11".
 * Can be called with (fromBus: number, toBus: number, busOffset = 1)
 * OR (identifier: string | number, branches: any[], busOffset = 1)
 */
export function formatBranchName(
  arg1: number | string,
  arg2?: number | any[],
  busOffset = 1
): string {
  // Signature 1: formatBranchName(fromBus: number, toBus: number, busOffset?: number)
  if (typeof arg1 === 'number' && typeof arg2 === 'number') {
    return `Line ${arg1 + busOffset}-${arg2 + busOffset}`;
  }

  // Signature 2: formatBranchName(elementId: string | number, branches: any[], busOffset?: number)
  if (Array.isArray(arg2)) {
    const branches = arg2;
    const str = String(arg1).trim().toLowerCase();
    if (str.startsWith('gen_') || str.startsWith('generator_')) {
      const gId = parseInt(str.replace('gen_', '').replace('generator_', ''), 10);
      return `Gen at Bus ${isNaN(gId) ? str : gId + busOffset}`;
    }

    const cleanId = str.replace('line_', '').replace('branch_', '');
    const numId = parseInt(cleanId, 10);
    if (!isNaN(numId)) {
      const found = branches.find((b) => b.id === numId);
      if (found) {
        return `Line ${found.from_bus + busOffset}-${found.to_bus + busOffset}`;
      }
    }
  }

  const str = String(arg1).trim();
  if (/^Line\s+\d+-\d+$/i.test(str)) {
    return str;
  }
  return str;
}

export interface OutcomeCategory {
  key: 'correct_warning' | 'correct_all_clear' | 'missed_cascade' | 'false_alarm';
  title: string;
  badgeClass: string;
  color: string;
  borderClass: string;
  description: string;
}

export function getOutcomeCategory(predictedCascade: boolean, actualCascade: boolean): OutcomeCategory {
  if (predictedCascade && actualCascade) {
    return {
      key: 'correct_warning',
      title: 'Correct warning',
      badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
      color: '#10b981',
      borderClass: 'border-emerald-500/40',
      description: 'The model flagged high cascading risk and the simulator verified cascade propagation.'
    };
  }
  if (!predictedCascade && !actualCascade) {
    return {
      key: 'correct_all_clear',
      title: 'Correct all-clear',
      badgeClass: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
      color: '#3b82f6',
      borderClass: 'border-blue-500/40',
      description: 'The model evaluated the outage as contained and the simulator confirmed stability.'
    };
  }
  if (!predictedCascade && actualCascade) {
    return {
      key: 'missed_cascade',
      title: 'Missed cascade',
      badgeClass: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
      color: '#f43f5e',
      borderClass: 'border-rose-500/40',
      description: 'Under-prediction: Outage was predicted safe, but simulator triggered cascading branch trips / load shed.'
    };
  }
  return {
    key: 'false_alarm',
    title: 'False alarm',
    badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    color: '#f59e0b',
    borderClass: 'border-amber-500/40',
    description: 'Over-prediction: The model warned of cascading failure, but the simulator absorbed the disturbance.'
  };
}
