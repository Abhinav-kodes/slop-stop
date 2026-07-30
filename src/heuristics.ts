export type Severity = 'PASS' | 'SUSPICIOUS' | 'HALLUCINATION';

export interface EvaluationResult {
  severity: Severity;
  reasons: string[];
}

const MAX_AGE_DAYS = 14;
const MIN_README_LENGTH = 100;

function daysSince(date: Date): number {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
}

export function evaluateNpmPackage(
  exists: boolean,
  data?: any,
): EvaluationResult {
  if (!exists) {
    return { severity: 'HALLUCINATION', reasons: ['Package does not exist on npm (404)'] };
  }

  const reasons: string[] = [];

  const created = data?.time?.created;
  if (created) {
    const age = daysSince(new Date(created));
    if (age < MAX_AGE_DAYS) {
      reasons.push(`Package created ${Math.round(age)} days ago (< ${MAX_AGE_DAYS} day threshold)`);
    }
  }

  const versionCount = data?.versions ? Object.keys(data.versions).length : 0;
  if (versionCount <= 1) {
    reasons.push(`Only ${versionCount} version(s) published`);
  }

  const readme = data?.readme || '';
  if (!readme || readme.trim().length < MIN_README_LENGTH) {
    reasons.push('Readme is empty or too short');
  }

  const maintainerCount = data?.maintainers?.length ?? 0;
  if (maintainerCount <= 1) {
    reasons.push('Fewer than 2 maintainers');
  }

  if (reasons.length > 0) {
    return { severity: 'SUSPICIOUS', reasons };
  }

  return { severity: 'PASS', reasons: [] };
}

export function evaluatePyPiPackage(
  exists: boolean,
  data?: any,
): EvaluationResult {
  if (!exists) {
    return { severity: 'HALLUCINATION', reasons: ['Package does not exist on PyPI (404)'] };
  }

  const reasons: string[] = [];
  const info = data?.info;

  if (info?.created) {
    const age = daysSince(new Date(info.created));
    if (age < MAX_AGE_DAYS) {
      reasons.push(`Package created ${Math.round(age)} days ago (< ${MAX_AGE_DAYS} day threshold)`);
    }
  }

  const releaseDates = data?.releases ? Object.keys(data.releases) : [];
  if (releaseDates.length <= 1) {
    reasons.push(`Only ${releaseDates.length} release(s) published`);
  }

  const description = info?.description || '';
  if (!description || description.trim().length < MIN_README_LENGTH) {
    reasons.push('Description is empty or too short');
  }

  const authorName = info?.author || '';
  if (!authorName) {
    reasons.push('No author information');
  }

  if (reasons.length > 0) {
    return { severity: 'SUSPICIOUS', reasons };
  }

  return { severity: 'PASS', reasons: [] };
}
