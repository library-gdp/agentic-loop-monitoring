const RFC3339 =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
}

/**
 * RFC 3339 시각을 UTC Unix epoch 마이크로초로 바꿉니다. 마이크로초보다 작은 단위는 버립니다.
 * 형식이나 날짜가 틀렸거나 결과가 안전한 정수 범위를 넘으면 undefined입니다.
 */
export function parseTimestampUs(value: string): number | undefined {
    const match = RFC3339.exec(value);
    if (!match) return undefined;
    const [, y, mo, d, h, mi, s, fraction = "", utc, sign, oh, om] = match;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
    // 윤초(60초)는 다음 초로 넘깁니다.
    if (hour > 23 || minute > 59 || second > 60) return undefined;

    let offsetMinutes = 0;
    if (utc === undefined) {
        const offsetHour = Number(oh);
        const offsetMinute = Number(om);
        if (offsetHour > 23 || offsetMinute > 59) return undefined;
        offsetMinutes = (sign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
    }

    // Date.UTC는 0~99년을 1900년대로 바꾸므로 setUTCFullYear로 연도를 정합니다.
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
    const epochSeconds = date.getTime() / 1000 - offsetMinutes * 60;
    const micros = Number(fraction.slice(0, 6).padEnd(6, "0"));
    const result = epochSeconds * 1_000_000 + micros;
    return Number.isSafeInteger(result) ? result : undefined;
}
