import React, { useState, useRef } from 'react';
import { UploadCloud, File, AlertCircle, Sparkles, CheckCircle } from 'lucide-react';

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
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
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

  const triggerInput = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="glass rounded-2xl p-6 shadow-sm" id="manual-upload-card">
      <div className="flex items-center gap-2.5 mb-4">
        <UploadCloud className="w-5 h-5 text-brand-gold" />
        <h3 className="font-display font-medium text-text-main text-sm">Direct Local Content Upload</h3>
      </div>

      <div
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={triggerInput}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${
          dragActive
            ? 'border-brand-gold bg-brand-gold/10'
            : 'border-brand-gold/10 hover:border-brand-gold/40 hover:bg-black/20'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={handleFileChange}
        />

        <div className="flex flex-col items-center">
          <UploadCloud className={`w-8 h-8 mb-2 ${dragActive ? 'text-brand-gold' : 'text-stone-500'}`} />
          <span className="text-sm font-semibold text-text-main">Drag and drop file here</span>
          <span className="text-xs text-text-muted mt-1">Accepts images and short mp4 videos</span>
        </div>
      </div>

      {selectedFile && (
        <div className="mt-4 p-3 bg-brand-gold/5 rounded-xl flex items-center gap-2.5 border border-brand-gold/20">
          <File className="w-5 h-5 text-brand-gold shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-text-main truncate mb-0.5">{selectedFile.name}</p>
            <p className="text-[10px] text-text-muted">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB • {selectedFile.type}</p>
          </div>
          {isProcessing ? (
            <div className="flex items-center gap-1.5 text-xs text-brand-gold font-medium">
              <Sparkles className="w-4 h-4 animate-spin" /> Analyzing...
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
              <CheckCircle className="w-4 h-4" /> Ready
            </div>
          )}
        </div>
      )}

      <div className="mt-4 flex gap-2 items-start text-xs text-text-muted bg-black/40 p-3.5 rounded-xl border border-brand-gold/10">
        <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
        <p className="leading-relaxed">
          <strong className="text-brand-gold font-medium">Workflow automation details:</strong> Local uploads are mirrored automatically onto your configuration's Google Drive parent folder, where captions are drafted by Gemini and later archived in the <code className="text-brand-gold font-mono bg-black/50 px-1 py-0.5 rounded">posted</code> subfolder!
        </p>
      </div>

    </div>
  );
}
