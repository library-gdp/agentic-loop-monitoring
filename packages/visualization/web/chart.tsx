import { useState } from "preact/hooks";
import type { TokenUsage } from "./api";
import { formatCount, TOKEN_SERIES, totalTokens } from "./format";

export interface TokenBar {
  readonly key: string;
  readonly label: string;
  readonly usage: TokenUsage;
}

const ROW = 22;
const GAP = 4;
const LABEL_WIDTH = 64;
const WIDTH = 820;
const SEGMENT_GAP = 2;

export function TokenLegend() {
  return (
    <ul class="legend">
      {TOKEN_SERIES.map((series) => (
        <li key={series.key}>
          <span class="swatch" style={{ background: series.color }} />
          {series.label}
        </li>
      ))}
    </ul>
  );
}

interface Hover {
  readonly bar: TokenBar;
  readonly x: number;
  readonly y: number;
}

/** 단위(LLM Call 등)별 Token Usage를 항목별로 쌓은 가로 막대입니다. 값은 표에도 있습니다. */
export function TokenChart({ bars }: { readonly bars: readonly TokenBar[] }) {
  const [hover, setHover] = useState<Hover | undefined>();
  const max = Math.max(1, ...bars.map((bar) => totalTokens(bar.usage)));
  const plot = WIDTH - LABEL_WIDTH - 72;
  const height = bars.length * (ROW + GAP);

  return (
    <div class="chart" onPointerLeave={() => setHover(undefined)}>
      <TokenLegend />
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="LLM Call별 Token Usage">
        {bars.map((bar, index) => {
          const y = index * (ROW + GAP);
          const total = totalTokens(bar.usage);
          let x = LABEL_WIDTH;
          return (
            <g
              key={bar.key}
              onPointerMove={(event) => {
                const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                if (box) setHover({ bar, x: event.clientX - box.left, y: event.clientY - box.top });
              }}
            >
              <rect class="hit" x="0" y={y} width={WIDTH} height={ROW + GAP} />
              <text class="axis-label" x={LABEL_WIDTH - 8} y={y + ROW / 2 + 4} text-anchor="end">
                {bar.label}
              </text>
              {TOKEN_SERIES.map((series) => {
                const value = bar.usage[series.key] ?? 0;
                if (value === 0) return null;
                const width = Math.max(1, (value / max) * plot - SEGMENT_GAP);
                const rect = (
                  <rect
                    key={series.key}
                    x={x}
                    y={y + 3}
                    width={width}
                    height={ROW - 6}
                    fill={series.color}
                  />
                );
                x += width + SEGMENT_GAP;
                return rect;
              })}
              <text class="axis-label" x={x + 6} y={y + ROW / 2 + 4}>
                {formatCount(total)}
              </text>
            </g>
          );
        })}
      </svg>
      {hover && (
        <div class="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <strong>{hover.bar.label}</strong>
          {TOKEN_SERIES.map((series) => (
            <div key={series.key} class="tooltip-row">
              <span class="line-key" style={{ background: series.color }} />
              <b>{formatCount(hover.bar.usage[series.key])}</b> {series.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
