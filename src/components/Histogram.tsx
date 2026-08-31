import { useEffect, useRef } from 'react';
import type { HistogramData } from '../lib/histogram';

interface HistogramProps {
  data: HistogramData | null;
}

const WIDTH = 288;
const HEIGHT = 72;

/** A live RGB histogram, channels overlaid with a "lighten" blend so
 * overlapping regions show up bright — the classic Lightroom/Camera Raw
 * look. Each channel is independently normalized to its own peak. */
export default function Histogram({ data }: HistogramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    if (!data) return;

    ctx.globalCompositeOperation = 'lighten';
    const draw = (values: Float32Array, color: string) => {
      let max = 1e-6;
      for (const v of values) max = Math.max(max, v);
      ctx.beginPath();
      ctx.moveTo(0, HEIGHT);
      for (let i = 0; i < values.length; i++) {
        const x = (i / (values.length - 1)) * WIDTH;
        const y = HEIGHT - (values[i] / max) * HEIGHT;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(WIDTH, HEIGHT);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    draw(data.r, 'rgba(255,70,70,0.72)');
    draw(data.g, 'rgba(70,230,120,0.72)');
    draw(data.b, 'rgba(80,150,255,0.72)');
    ctx.globalCompositeOperation = 'source-over';
  }, [data]);

  return <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} className="histogram-canvas" />;
}
