import React, { useState, useRef } from 'react';
import { UploadCloud, File, Sparkles, CheckCircle } from 'lucide-react';

interface ManualUploadProps {
  onUpload: (file: File) => void;
  isProcessing: boolean;
}

export default function ManualUploadCard({ onUpload, isProcessing }: ManualUploadProps) {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        setSelectedFile(file);
        onUpload(file);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      onUpload(file);
    }
  };

  return (
    <div className="bg-surface-dark border border-white/10 rounded-2xl p-5" id="manual-upload-card">
      <div className="flex items-center justify-between mb-3.5">
        <h3 className="text-sm font-semibold text-zinc-100">Upload Media</h3>
        <span className="text-xs text-zinc-500">Syncs to Drive &amp; drafts captions</span>
      </div>

      <div
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border border-dashed rounded-xl px-5 py-8 text-center cursor-pointer transition-colors ${
          dragActive
            ? 'border-amber-400 bg-amber-400/5'
            : 'border-white/15 hover:border-white/30 hover:bg-white/[0.02]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={handleFileChange}
        />

        <div className="flex flex-col items-center gap-1.5">
          <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center mb-1">
            <UploadCloud className={`w-5 h-5 ${dragActive ? 'text-amber-400' : 'text-zinc-400'}`} />
          </div>
          <span className="text-sm font-medium text-zinc-200">
            Drop an image or video here, or browse
          </span>
          <span className="text-xs text-zinc-500">
            Images or MP4 clips up to 10 MB
          </span>
        </div>
      </div>

      {selectedFile && (
        <div className="mt-3.5 px-3.5 py-2.5 bg-white/[0.03] rounded-xl flex items-center gap-3 border border-white/10">
          <File className="w-4 h-4 text-zinc-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-zinc-200 truncate">{selectedFile.name}</p>
            <p className="text-[11px] text-zinc-500">
              {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
          {isProcessing ? (
            <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
              <Sparkles className="w-3.5 h-3.5 animate-spin" />
              Drafting...
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
              <CheckCircle className="w-3.5 h-3.5" />
              Ready
            </div>
          )}
        </div>
      )}
    </div>
  );
}
