const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?<fraction>\.\d+)?(?<zone>[Zz]|[+-]\d{2}:\d{2})$/;

/** RFC 3339 시각을 UTC Unix epoch 마이크로초로 바꿉니다. 형식이 틀리면 undefined입니다. */
export function parseTimestampUs(value: string): number | undefined {
  const match = RFC3339.exec(value);
  if (!match) return undefined;
  const fraction = match.groups?.fraction ?? "";
  const seconds = Date.parse(value.replace(fraction, ""));
  if (Number.isNaN(seconds)) return undefined;
  const micros = Math.floor(Number(`0${fraction || ".0"}`) * 1_000_000 + 1e-6);
  return seconds * 1000 + micros;
}
