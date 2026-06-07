import React, { useState, useEffect } from 'react';
import { Smartphone, Bell, Eye, Share2, CornerDownRight, Check, Sparkles, MessageSquare } from 'lucide-react';
import { PostItem } from '../types';

interface PhoneSimulatorProps {
  activePost: PostItem | null;
  onSelectCaption: (caption: string) => void;
  onRegenerate: () => void;
  onPublish: (caption: string) => void;
  onSkip: () => void;
  isPublishing: boolean;
  isRegenerating: boolean;
}

export default function PhoneSimulator({
  activePost,
  onSelectCaption,
  onRegenerate,
  onPublish,
  onSkip,
  isPublishing,
  isRegenerating,
}: PhoneSimulatorProps) {
  const [editedCaption, setEditedCaption] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showNotification, setShowNotification] = useState(false);

  useEffect(() => {
    if (activePost) {
      setEditedCaption(activePost.captions[0] || '');
      setSelectedIdx(0);
      // Trigger notification slide-in
      setShowNotification(true);
      const timer = setTimeout(() => {
        // Vibrates if supported
        if (typeof window !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate([100, 50, 100]);
        }
      }, 500);
      return () => clearTimeout(timer);
    } else {
      setShowNotification(false);
    }
  }, [activePost]);

  const selectIdx = (idx: number, text: string) => {
    setSelectedIdx(idx);
    setEditedCaption(text);
    onSelectCaption(text);
  };

  return (
    <div className="flex flex-col items-center select-none" id="phone-simulator">
      {/* Phone container */}
      <div className="relative w-full max-w-[340px] h-[680px] bg-stone-950 rounded-[50px] border-[12px] border-stone-900 shadow-2xl flex flex-col justify-between overflow-hidden outline outline-1 outline-brand-gold/25">
        
        {/* Dynamic Notch / Island */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-black rounded-b-2xl z-50 flex items-center justify-center gap-1.5 px-3">
          <div className="w-3 h-3 rounded-full bg-brand-gold/40 border border-black" />
          <div className="w-1.5 h-1.5 rounded-full bg-stone-800" />
        </div>

        {/* Custom Slide-In Phone Notification Banner */}
        {showNotification && activePost && (
          <div className="absolute top-10 left-1.5 right-1.5 bg-black/95 backdrop-blur-md border border-brand-gold/30 rounded-2xl p-3 shadow-lg z-50 animate-bounce transition-all">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="bg-brand-gold p-1 rounded-lg text-bg-dark">
                <Bell className="w-3.5 h-3.5" />
              </div>
              <div className="flex-1">
                <h4 className="text-xs font-bold text-text-main font-sans">New Social Content Package</h4>
                <p className="text-[10px] text-text-muted">Selected photo: {activePost.fileName}</p>
              </div>
              <span className="text-[9px] text-brand-gold font-mono font-bold">now</span>
            </div>
            <p className="text-text-main text-[11px] line-clamp-2 leading-relaxed italic">
              "{activePost.captions[0] || 'Caption review required...'}"
            </p>
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setShowNotification(false)}
                className="px-2.5 py-1 bg-stone-900 hover:bg-stone-800 text-stone-300 text-[10px] font-semibold rounded-lg border border-stone-800"
              >
                Dismiss
              </button>
              <button
                type="button"
                className="px-2.5 py-1 bg-brand-gold hover:bg-brand-gold-dark text-bg-dark text-[10px] font-bold rounded-lg"
                onClick={() => setShowNotification(false)}
              >
                Review Card
              </button>
            </div>
          </div>
        )}

        {/* Screen Content Wrapper */}
        <div className="flex-1 bg-stone-950 flex flex-col p-4 pt-10 text-text-main overflow-y-auto no-scrollbar">
          
          {/* Header */}
          <div className="flex justify-between items-center mb-4 pb-2 border-b border-brand-gold/10">
            <span className="text-xs font-semibold text-brand-gold font-mono">10:42 PM</span>
            <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted font-bold flex items-center gap-1">
              <Smartphone className="w-3 h-3 text-brand-gold" /> Mobile Hub
            </span>
          </div>

          {!activePost ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-12">
              <div className="w-14 h-14 bg-black border border-brand-gold/20 text-brand-gold rounded-full flex items-center justify-center mb-4 animate-pulse">
                <Bell className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-semibold text-text-main font-sans">No Pending Proposals</h3>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">
                Trigger a Google Drive poll or upload a photo manually to generate caption variants.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              
              {/* Media Preview Box */}
              <div className="relative aspect-video rounded-xl bg-stone-900 overflow-hidden border border-brand-gold/25">
                <img
                  src={activePost.imageUrl}
                  alt={activePost.fileName}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
                <span className="absolute bottom-2 left-2 text-[9px] bg-black/80 backdrop-blur-sm text-brand-gold px-2 py-0.5 rounded-full font-mono font-bold">
                  {activePost.fileName}
                </span>
              </div>

              {/* Caption Selection List */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-[11px] font-mono tracking-wider font-semibold text-brand-gold uppercase flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> Select Caption Variant
                  </span>
                  <button
                    type="button"
                    onClick={onRegenerate}
                    disabled={isRegenerating}
                    className="text-[10px] text-text-muted font-semibold hover:text-brand-gold transition duration-200 cursor-pointer"
                  >
                    {isRegenerating ? 'Regenerating...' : 'Regenerate 3'}
                  </button>
                </div>

                {activePost.captions.map((cap, i) => (
                  <div
                    key={i}
                    onClick={() => selectIdx(i, cap)}
                    className={`p-3 rounded-xl border text-left cursor-pointer transition relative group ${
                      selectedIdx === i
                        ? 'bg-brand-gold/10 border-brand-gold/60'
                        : 'bg-black/40 border-brand-gold/10 hover:border-brand-gold/30'
                    }`}
                  >
                    <div className="absolute top-2 right-2 flex items-center gap-1">
                      {selectedIdx === i && (
                        <span className="bg-brand-gold text-bg-dark rounded-full p-0.5">
                          <Check className="w-2.5 h-2.5" />
                        </span>
                      )}
                    </div>
                    <span className="text-[9px] text-brand-gold font-bold font-mono">Caption #{i + 1}</span>
                    <p className="text-xs text-text-main mt-1 leading-relaxed">
                      {cap}
                    </p>
                  </div>
                ))}
              </div>

              {/* Editing text section */}
              <div className="space-y-1 bg-black/45 border border-brand-gold/10 p-3 rounded-xl">
                <span className="text-[9px] text-brand-gold font-bold uppercase font-mono flex items-center gap-1">
                  <MessageSquare className="w-3 h-3 text-brand-gold" /> Customize Caption
                </span>
                <textarea
                  value={editedCaption}
                  onChange={(e) => {
                    setEditedCaption(e.target.value);
                    onSelectCaption(e.target.value);
                  }}
                  rows={3}
                  className="w-full bg-transparent text-xs text-text-main placeholder:text-stone-700 outline-none resize-none pt-1 border-0 ring-0 focus:ring-0 focus:ring-offset-0"
                />
              </div>

              {/* Interactive buttons */}
              <div className="grid grid-cols-2 gap-2 pt-2">
                <button
                  type="button"
                  onClick={onSkip}
                  className="px-3 py-2.5 bg-red-950/20 border border-red-500/20 hover:bg-red-950/40 active:bg-red-950 text-xs font-semibold rounded-xl text-red-400 transition cursor-pointer"
                >
                  Skip Item / Decline
                </button>
                <button
                  type="button"
                  onClick={() => onPublish(editedCaption)}
                  disabled={isPublishing}
                  className="px-3 py-2.5 btn-gold text-xs font-bold rounded-xl transition flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  {isPublishing ? 'Publishing...' : 'Publish Content'}
                </button>
              </div>

              <div className="text-[10px] text-text-muted text-center flex items-center justify-center gap-1">
                <CornerDownRight className="w-3 h-3 text-brand-gold" />
                <span>Publishes simultaneously to X & Bluesky</span>
              </div>

            </div>
          )}

        </div>

        {/* Backbar indicator */}
        <div className="h-4 bg-stone-950 flex items-center justify-center pb-2">
          <div className="w-24 h-1.5 bg-stone-850 rounded-full" />
        </div>

      </div>
      
      <span className="text-xs text-brand-gold/60 font-semibold py-2">Smartphone Live Sandbox Preview</span>
    </div>
  );
}
