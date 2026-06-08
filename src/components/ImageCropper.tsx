import React, { useState, useEffect, useRef } from 'react';
import { Crop, X, Check } from 'lucide-react';

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
      
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

      const rect = imageRef.current.getBoundingClientRect();
      const dxPercent = ((clientX - dragInfo.startX) / rect.width) * 100;
      const dyPercent = ((clientY - dragInfo.startY) / rect.height) * 100;

      let newCrop = { ...dragInfo.startCrop };

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

    const endDrag = () => {
      setDragInfo(null);
    };

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
        const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.9);
        onSave(croppedDataUrl);
      }
    };
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-4 bg-black/90 backdrop-blur-md">
      <div className="w-full max-w-3xl flex flex-col bg-stone-900 border border-brand-gold/30 rounded-2xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between border-b border-brand-gold/15 bg-black/45">
          <div className="flex items-center gap-2 text-brand-gold">
            <Crop className="w-5 h-5" />
            <h3 className="font-display font-bold text-sm tracking-tight uppercase">Crop Photo Editor</h3>
          </div>
          <button
            onClick={onCancel}
            className="p-1 px-2 text-[10px] uppercase tracking-wider font-extrabold rounded bg-black/40 hover:bg-black/70 text-stone-400 hover:text-text-main transition border border-brand-gold/5"
          >
            Cancel
          </button>
        </div>

        {/* Workspace */}
        <div className="p-8 flex items-center justify-center bg-black/40 overflow-hidden min-h-[300px] max-h-[60vh]">
          <div className="relative inline-block overflow-hidden max-w-full select-none rounded-lg border border-stone-800">
            <img
              src={imageUrl}
              ref={imageRef}
              alt="Crop target"
              className="max-w-full max-h-[50vh] object-contain pointer-events-none"
            />

            {/* Custom Backdrop Overlay parts around the crop box */}
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

            {/* The Crop Area Box */}
            <div
              className="absolute border-2 border-brand-gold cursor-move shadow-[0_0_0_9999px_rgba(0,0,0,0)]"
              style={{
                left: `${crop.x}%`,
                top: `${crop.y}%`,
                width: `${crop.w}%`,
                height: `${crop.h}%`,
              }}
              onMouseDown={(e) => startDrag(e, 'move')}
              onTouchStart={(e) => startDrag(e, 'move')}
            >
              {/* Draggable Corner Handles */}
              {/* Top Left */}
              <div
                className="absolute -top-2 -left-2 w-4 h-4 bg-brand-gold border-2 border-stone-900 rounded-full cursor-nwse-resize z-20 flex items-center justify-center"
                onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'resize-TL'); }}
                onTouchStart={(e) => { e.stopPropagation(); startDrag(e, 'resize-TL'); }}
              />
              {/* Top Right */}
              <div
                className="absolute -top-2 -right-2 w-4 h-4 bg-brand-gold border-2 border-stone-900 rounded-full cursor-nesw-resize z-20 flex items-center justify-center"
                onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'resize-TR'); }}
                onTouchStart={(e) => { e.stopPropagation(); startDrag(e, 'resize-TR'); }}
              />
              {/* Bottom Left */}
              <div
                className="absolute -bottom-2 -left-2 w-4 h-4 bg-brand-gold border-2 border-stone-900 rounded-full cursor-nesw-resize z-20 flex items-center justify-center"
                onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'resize-BL'); }}
                onTouchStart={(e) => { e.stopPropagation(); startDrag(e, 'resize-BL'); }}
              />
              {/* Bottom Right */}
              <div
                className="absolute -bottom-2 -right-2 w-4 h-4 bg-brand-gold border-2 border-stone-900 rounded-full cursor-nwse-resize z-20 flex items-center justify-center"
                onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'resize-BR'); }}
                onTouchStart={(e) => { e.stopPropagation(); startDrag(e, 'resize-BR'); }}
              />
            </div>
          </div>
        </div>

        {/* Footer controls */}
        <div className="px-6 py-4 bg-stone-900/60 border-t border-brand-gold/10 flex items-center justify-between">
          <p className="text-[11px] text-stone-500 font-sans">
            Drag the corners to resize. Drag the center to move the crop box.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={onCancel}
              className="px-5 py-2 hover:bg-white/5 text-stone-400 hover:text-text-main text-xs font-bold rounded-xl transition"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-5 py-2 bg-brand-gold/15 hover:bg-brand-gold/25 border border-brand-gold/30 text-brand-gold text-xs font-bold rounded-xl transition flex items-center gap-1.5"
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
