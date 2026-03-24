const DEFAULT_MAX_POST_AGE_HOURS = 24;

export function getMaxPostAgeHours() {
  const value = Number(process.env.MAX_POST_AGE_HOURS || DEFAULT_MAX_POST_AGE_HOURS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_POST_AGE_HOURS;
}

export function getRecentPostCutoff(now = new Date()) {
  return new Date(now.getTime() - getMaxPostAgeHours() * 60 * 60 * 1000);
}

export function isRecentDate(value: Date | string | null | undefined, now = new Date()) {
  if (!value) {
    return false;
  }

  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return timestamp >= getRecentPostCutoff(now).getTime();
}

export function buildRecentPostWhere(now = new Date()) {
  const cutoff = getRecentPostCutoff(now);
  return {
    OR: [
      { postedAt: { gte: cutoff } },
      {
        postedAt: null,
        discoveredAt: { gte: cutoff },
      },
    ],
  };
}
