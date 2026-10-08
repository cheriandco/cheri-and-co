"use client";

import { useState } from "react";
import type { FunnelStage, TrendSeries } from "@/types";

export function Sparkline({ data, label }: { data: number[]; label: string }) {
  const min = Math.min(...data), max = Math.max(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 24}`).join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={`${label} trend`}>
      <polyline points={pts} fill="none" stroke="var(--rose)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const W = 720, H = 250, PX = 36, PY = 20;

export function TrendChart({ series }: { series: TrendSeries }) {
  const [range, setRange] = useState<keyof TrendSeries>("30d");
  const [hover, setHover] = useState<number | null>(null);
  const data = series[range];
  const max = Math.ceil(Math.max(...data.flatMap((d) => [d.b2c, d.b2b * 4])) / 20) * 20;
  // B2B volumes are far smaller, so they are plotted on a x4 scale; the tooltip shows true values.
  const x = (i: number) => PX + (i / (data.length - 1)) * (W - PX * 2);
  const y = (v: number) => H - PY - (v / max) * (H - PY * 2);
  const path = (f: (d: (typeof data)[number]) => number) => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(f(d)).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div>
      <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div className="legend">
          <span><i style={{ background: "var(--rose)" }} />B2C enquiries</span>
          <span><i style={{ background: "var(--ink)" }} />B2B leads (×4 scale)</span>
        </div>
        <div className="seg" role="group" aria-label="Trend range">
          {(["7d", "30d", "90d"] as const).map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => { setRange(r); setHover(null); }}>{r === "7d" ? "7 Days" : r === "30d" ? "30 Days" : "90 Days"}</button>
          ))}
        </div>
      </div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Enquiries and leads trend, ${range}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PX} x2={W - PX} y1={y(max * t)} y2={y(max * t)} stroke="var(--line)" strokeWidth="1" />
            <text x={PX - 8} y={y(max * t) + 4} textAnchor="end">{Math.round(max * t)}</text>
          </g>
        ))}
        <path d={path((d) => d.b2c)} fill="none" stroke="var(--rose)" strokeWidth="2" strokeLinejoin="round" />
        <path d={path((d) => d.b2b * 4)} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinejoin="round" />
        {data.map((d, i) => (i % Math.ceil(data.length / 7) === 0 ? <text key={i} x={x(i)} y={H - 2} textAnchor="middle">{d.label}</text> : null))}
        {data.map((_, i) => (
          <rect key={i} x={x(i) - (W - PX * 2) / (data.length - 1) / 2} y={PY} width={(W - PX * 2) / (data.length - 1)} height={H - PY * 2} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PY} y2={H - PY} stroke="var(--line-strong)" />
            <circle cx={x(hover)} cy={y(data[hover].b2c)} r="4" fill="var(--rose)" />
            <circle cx={x(hover)} cy={y(data[hover].b2b * 4)} r="4" fill="var(--ink)" />
            <g transform={`translate(${Math.min(x(hover) + 10, W - 150)},${PY})`}>
              <rect width="140" height="52" rx="8" fill="var(--surface)" stroke="var(--line-strong)" />
              <text x="10" y="18" style={{ fill: "var(--ink)", fontWeight: 600 }}>{data[hover].label}</text>
              <text x="10" y="33">B2C: {data[hover].b2c}</text>
              <text x="10" y="46">B2B: {data[hover].b2b}</text>
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}

export function PipelineFunnel({ stages }: { stages: FunnelStage[] }) {
  const top = stages[0]?.count || 1;
  return (
    <div className="funnel" role="list" aria-label="Sales pipeline funnel">
      {stages.map((s, i) => {
        const w = Math.max((s.count / top) * 100, 6);
        const last = i === stages.length - 1;
        return (
          <div className="funnel-row" role="listitem" key={s.stage}>
            <span>{s.label}</span>
            <div className="funnel-bar"><i style={{ width: `${w}%`, ["--c" as string]: last ? "var(--rose-deep)" : `color-mix(in srgb, var(--rose) ${30 + i * 12}%, var(--line-strong))` }} /></div>
            <span className="num"><b style={{ fontWeight: 500 }}>{s.count}</b> <span className="pct">{Math.round((s.count / top) * 100)}%</span></span>
          </div>
        );
      })}
    </div>
  );
}

export function BarChart({ data, title }: { data: { label: string; value: number }[]; title: string }) {
  const max = Math.max(...data.map((d) => d.value)) * 1.1;
  const bw = 600 / data.length;
  return (
    <svg className="chart" viewBox="0 0 640 230" role="img" aria-label={title}>
      {[0, 0.5, 1].map((t) => <line key={t} x1="20" x2="630" y1={190 - t * 170} y2={190 - t * 170} stroke="var(--line)" />)}
      {data.map((d, i) => {
        const h = (d.value / max) * 170;
        return (
          <g key={d.label}>
            <rect x={20 + i * bw + bw * 0.22} y={190 - h} width={bw * 0.56} height={h} rx="6" fill={i === data.length - 1 ? "var(--rose-deep)" : "var(--rose)"} opacity={i === data.length - 1 ? 1 : 0.55} />
            <text x={20 + i * bw + bw / 2} y={186 - h} textAnchor="middle" style={{ fill: "var(--ink)" }}>{d.value}</text>
            <text x={20 + i * bw + bw / 2} y="212" textAnchor="middle">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
