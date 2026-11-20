import 'fake-indexeddb/auto';
import { vi } from 'vitest';

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function (type: string) {
    if (type === '2d') {
      return {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
          data: new Uint8ClampedArray(128 * 128 * 4),
          width: 128,
          height: 128,
        })),
        putImageData: vi.fn(),
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        scale: vi.fn(),
        setLineDash: vi.fn(),
        strokeRect: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        rect: vi.fn(),
        roundRect: vi.fn(),
        clip: vi.fn(),
      } as any;
    }
    return null;
  };

  HTMLCanvasElement.prototype.toDataURL = function () {
    return 'data:image/png;base64,fakePngDataUrl';
  };
}
