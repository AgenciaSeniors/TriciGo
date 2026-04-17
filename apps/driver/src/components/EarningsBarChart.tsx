import React from 'react';
import { View, Dimensions } from 'react-native';
import Svg, { Rect, Text as SvgText, Line } from 'react-native-svg';
import { colors } from '@tricigo/theme';
import { formatCUP } from '@tricigo/utils';

export interface BarChartDataPoint {
  label: string;
  value: number;
  isToday?: boolean;
}

interface EarningsBarChartProps {
  data: BarChartDataPoint[];
  height?: number;
  theme?: 'light' | 'dark';
}

export function EarningsBarChart({ data, height = 160, theme = 'dark' }: EarningsBarChartProps) {
  const isLight = theme === 'light';
  if (data.length === 0) return null;

  const screenWidth = Dimensions.get('window').width;
  const chartWidth = screenWidth - 56; // px-5 + padding
  const paddingLeft = 50;
  const paddingBottom = 24;
  const paddingTop = 8;
  const chartH = height - paddingBottom - paddingTop;

  const maxValue = Math.max(...data.map((d) => d.value), 1);
  const barGap = 4;
  const barWidth = Math.min(
    32,
    (chartWidth - paddingLeft - barGap * data.length) / Math.max(data.length, 1),
  );

  // Grid lines (3 horizontal reference lines)
  const gridLines = [0.25, 0.5, 0.75, 1].map((pct) => ({
    y: paddingTop + chartH * (1 - pct),
    label: formatCUP(Math.round(maxValue * pct)).replace(' CUP', ''),
  }));

  return (
    <View
      className="rounded-xl p-3 mb-4"
      style={isLight
        ? { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }
        : { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }
      }
    >
      <Svg width={chartWidth} height={height}>
        {/* Grid lines */}
        {gridLines.map((line, i) => (
          <React.Fragment key={`grid-${i}`}>
            <Line
              x1={paddingLeft}
              y1={line.y}
              x2={chartWidth}
              y2={line.y}
              stroke={isLight ? '#F1F5F9' : 'rgba(255,255,255,0.08)'}
              strokeWidth={1}
            />
            <SvgText
              x={paddingLeft - 6}
              y={line.y + 4}
              fill={isLight ? '#64748B' : 'rgba(255,255,255,0.35)'}
              fontSize={9}
              textAnchor="end"
            >
              {line.label}
            </SvgText>
          </React.Fragment>
        ))}

        {/* Bars */}
        {data.map((d, i) => {
          const barH = Math.max((d.value / maxValue) * chartH, 2);
          const x = paddingLeft + i * (barWidth + barGap) + barGap / 2;
          const y = paddingTop + chartH - barH;

          return (
            <React.Fragment key={`bar-${i}`}>
              <Rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                rx={3}
                fill={d.isToday
                  ? colors.brand.orange
                  : isLight ? '#E2E8F0' : 'rgba(249,115,22,0.6)'
                }
              />
              {/* Label */}
              <SvgText
                x={x + barWidth / 2}
                y={height - 4}
                fill={isLight ? '#64748B' : 'rgba(255,255,255,0.45)'}
                fontSize={data.length > 10 ? 7 : 9}
                textAnchor="middle"
              >
                {d.label}
              </SvgText>
            </React.Fragment>
          );
        })}
      </Svg>
    </View>
  );
}
