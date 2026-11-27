import React, { useState, useEffect, useRef } from 'react';
import { Crop, Check, X } from 'lucide-react';

interface ImageCropperProps {
  imageUrl: string;
  onSave: (croppedDataUrl: string) => void;
  onCancel: () => void;
}

export default function ImageCropper({ imageUrl, onSave, onCancel }: ImageCropperProps) {
  const [crop, setCrop] = useState({ x: 15, y: 15, w: 70, h: 70 });
  const [dragInfo, setDragInfo] = useState<{
    action: string;
    startX: number;
    startY: number;
    startCrop: typeof crop;
  } | null>(null);

  const imageRef = useRef<HTMLImageElement>(null);

  const startDrag = (e: React.MouseEvent | React.TouchEvent, action: string) => {
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    setDragInfo({
      action,
      startX: clientX,
      startY: clientY,
      startCrop: { ...crop },
    });
  };

  useEffect(() => {
    const handleDrag = (e: MouseEvent | TouchEvent) => {
      if (!dragInfo || !imageRef.current) return;
      if ('touches' in e) e.preventDefault();

      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

      const rect = imageRef.current.getBoundingClientRect();
      const dxPercent = ((clientX - dragInfo.startX) / rect.width) * 100;
      const dyPercent = ((clientY - dragInfo.startY) / rect.height) * 100;

      const newCrop = { ...dragInfo.startCrop };

      if (dragInfo.action === 'move') {
        newCrop.x = Math.max(0, Math.min(100 - newCrop.w, dragInfo.startCrop.x + dxPercent));
        newCrop.y = Math.max(0, Math.min(100 - newCrop.h, dragInfo.startCrop.y + dyPercent));
      } else if (dragInfo.action === 'resize-TL') {
        newCrop.x = Math.max(0, Math.min(dragInfo.startCrop.x + dragInfo.startCrop.w - 10, dragInfo.startCrop.x + dxPercent));
        newCrop.w = dragInfo.startCrop.x + dragInfo.startCrop.w - newCrop.x;
        newCrop.y = Math.max(0, Math.min(dragInfo.startCrop.y + dragInfo.startCrop.h - 10, dragInfo.startCrop.y + dyPercent));
        newCrop.h = dragInfo.startCrop.y + dragInfo.startCrop.h - newCrop.y;
      } else if (dragInfo.action === 'resize-TR') {
        newCrop.w = Math.max(10, Math.min(100 - dragInfo.startCrop.x, dragInfo.startCrop.w + dxPercent));
        newCrop.y = Math.max(0, Math.min(dragInfo.startCrop.y + dragInfo.startCrop.h - 10, dragInfo.startCrop.y + dyPercent));
        newCrop.h = dragInfo.startCrop.y + dragInfo.startCrop.h - newCrop.y;
      } else if (dragInfo.action === 'resize-BL') {
        newCrop.x = Math.max(0, Math.min(dragInfo.startCrop.x + dragInfo.startCrop.w - 10, dragInfo.startCrop.x + dxPercent));
        newCrop.w = dragInfo.startCrop.x + dragInfo.startCrop.w - newCrop.x;
        newCrop.h = Math.max(10, Math.min(100 - dragInfo.startCrop.y, dragInfo.startCrop.h + dyPercent));
      } else if (dragInfo.action === 'resize-BR') {
        newCrop.w = Math.max(10, Math.min(100 - dragInfo.startCrop.x, dragInfo.startCrop.w + dxPercent));
        newCrop.h = Math.max(10, Math.min(100 - dragInfo.startCrop.y, dragInfo.startCrop.h + dyPercent));
      }

      setCrop(newCrop);
    };

    const endDrag = () => setDragInfo(null);

    if (dragInfo) {
      window.addEventListener('mousemove', handleDrag);
      window.addEventListener('mouseup', endDrag);
      window.addEventListener('touchmove', handleDrag, { passive: false });
      window.addEventListener('touchend', endDrag);
    }

    return () => {
      window.removeEventListener('mousemove', handleDrag);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('touchmove', handleDrag);
      window.removeEventListener('touchend', endDrag);
    };
  }, [dragInfo]);

  const handleSave = () => {
    if (!imageRef.current) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageUrl;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const xPixel = (crop.x / 100) * img.naturalWidth;
      const yPixel = (crop.y / 100) * img.naturalHeight;
      const wPixel = (crop.w / 100) * img.naturalWidth;
      const hPixel = (crop.h / 100) * img.naturalHeight;

      canvas.width = wPixel;
      canvas.height = hPixel;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, xPixel, yPixel, wPixel, hPixel, 0, 0, wPixel, hPixel);
        onSave(canvas.toDataURL('image/jpeg', 0.9));
      }
    };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-3xl flex flex-col bg-surface-dark border border-white/15 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-3.5 flex items-center justify-between border-b border-white/10">
          <div className="flex items-center gap-2 text-zinc-100">
            <Crop className="w-4 h-4 text-zinc-400" />
            <h3 className="font-semibold text-sm">Crop Photo</h3>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition cursor-pointer"
            aria-label="Cancel crop"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 flex items-center justify-center bg-black/60 overflow-hidden min-h-[280px] max-h-[65vh]">
          <div className="relative inline-block overflow-hidden max-w-full select-none touch-none rounded-lg border border-white/10">
            <img
              src={imageUrl}
              ref={imageRef}
              alt="Crop target"
              className="max-w-full max-h-[52vh] object-contain pointer-events-none"
            />

            <div className="absolute top-0 left-0 right-0 bg-black/65" style={{ height: `${crop.y}%` }} />
            <div className="absolute bottom-0 left-0 right-0 bg-black/65" style={{ top: `${crop.y + crop.h}%` }} />
            <div
              className="absolute bg-black/65"
              style={{
                top: `${crop.y}%`,
                bottom: `${100 - (crop.y + crop.h)}%`,
                left: 0,
                width: `${crop.x}%`,
              }}
            />
            <div
              className="absolute bg-black/65"
              style={{
                top: `${crop.y}%`,
                bottom: `${100 - (crop.y + crop.h)}%`,
                right: 0,
                left: `${crop.x + crop.w}%`,
              }}
            />

            <div
              className="absolute border-2 border-white cursor-move"
              style={{
                left: `${crop.x}%`,
                top: `${crop.y}%`,
                width: `${crop.w}%`,
                height: `${crop.h}%`,
              }}
              onMouseDown={(e) => startDrag(e, 'move')}
              onTouchStart={(e) => startDrag(e, 'move')}
            >
              <div
                className="absolute -top-2.5 -left-2.5 w-5 h-5 bg-white border-2 border-zinc-900 rounded-full cursor-nwse-resize z-20 shadow"
                onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'resize-TL'); }}
                onTouchStart={(e) => { e.stopPropagation(); startDrag(e, 'resize-TL'); }}
              />
              <div
                className="absolute -top-2.5 -right-2.5 w-5 h-5 bg-white border-2 border-zinc-900 rounded-full cursor-nesw-resize z-20 shadow"
                onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'resize-TR'); }}
                onTouchStart={(e) => { e.stopPropagation(); startDrag(e, 'resize-TR'); }}
              />
              <div
                className="absolute -bottom-2.5 -left-2.5 w-5 h-5 bg-white border-2 border-zinc-900 rounded-full cursor-nesw-resize z-20 shadow"
                onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'resize-BL'); }}
                onTouchStart={(e) => { e.stopPropagation(); startDrag(e, 'resize-BL'); }}
              />
              <div
                className="absolute -bottom-2.5 -right-2.5 w-5 h-5 bg-white border-2 border-zinc-900 rounded-full cursor-nwse-resize z-20 shadow"
                onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'resize-BR'); }}
                onTouchStart={(e) => { e.stopPropagation(); startDrag(e, 'resize-BR'); }}
              />
            </div>
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-white/10 flex items-center justify-between gap-3">
          <p className="text-xs text-zinc-500 hidden sm:block">
            Drag corners to resize or drag inside to move.
          </p>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-white/5 rounded-lg transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 btn-gold text-xs rounded-lg flex items-center gap-1.5 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Apply Crop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
