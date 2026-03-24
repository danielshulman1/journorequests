export const DEFAULT_SCAN_INTERVAL_MINUTES = 60;
export const DEFAULT_EMAIL_INTERVAL_MINUTES = 1440;

export const scanIntervalOptions = [
  { value: 15, label: "Every 15 minutes" },
  { value: 30, label: "Every 30 minutes" },
  { value: 60, label: "Every hour" },
  { value: 180, label: "Every 3 hours" },
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Twice a day" },
  { value: 1440, label: "Once a day" },
];

export const emailIntervalOptions = [
  { value: 60, label: "Every hour" },
  { value: 180, label: "Every 3 hours" },
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Twice a day" },
  { value: 1440, label: "Once a day" },
  { value: 10080, label: "Once a week" },
];

export function parseScheduleInterval(
  value: unknown,
  allowedValues: number[],
  fallback: number,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !allowedValues.includes(parsed)) {
    return fallback;
  }

  return parsed;
}
