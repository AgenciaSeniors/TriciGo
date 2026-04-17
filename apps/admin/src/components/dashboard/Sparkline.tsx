'use client';

/**
 * Minimal SVG sparkline. Accepts a numeric series and renders a smooth
 * path plus an accent dot on the last point. No external deps.
 *
 * The series is expected in chronological order (oldest → newest).
 * When all values are equal, a flat middle line is drawn.
 */
type Props = {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  className?: string;
  strokeWidth?: number;
  showDot?: boolean;
};

export function Sparkline({
  data,
  width = 120,
  height = 36,
  stroke = 'currentColor',
  fill,
  strokeWidth = 1.75,
  showDot = true,
  className,
}: Props) {
  if (!data.length) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const stepX = data.length > 1 ? width / (data.length - 1) : 0;

  const points = data.map((v, i) => {
    const x = i * stepX;
    // inset 2px top/bottom so stroke doesn't clip
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return { x, y };
  });

  const path = points
    .map((p, i) => {
      if (i === 0) return `M ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
      const prev = points[i - 1]!;
      const cx = (prev.x + p.x) / 2;
      return `Q ${cx.toFixed(2)} ${prev.y.toFixed(2)} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    })
    .join(' ');

  const last = points[points.length - 1]!;
  const areaPath = `${path} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      {fill && <path d={areaPath} fill={fill} opacity={0.9} />}
      <path d={path} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      {showDot && (
        <circle
          cx={last.x}
          cy={last.y}
          r={strokeWidth + 1}
          fill={stroke}
        />
      )}
    </svg>
  );
}
