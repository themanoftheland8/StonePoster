import React, { useState } from 'react';
import { UserConfig } from '../types';
import { Save, Shield, Settings, Key, Database, RefreshCw, Layers } from 'lucide-react';

interface ConfigManagerProps {
  config: UserConfig;
  onSave: (newConfig: UserConfig) => void;
  isLoading: boolean;
}

export default function ConfigManager({ config, onSave, isLoading }: ConfigManagerProps) {
  const [formData, setFormData] = useState<UserConfig>({
    driveFolderId: config.driveFolderId || '1hsvMRVzXYXjadHot1PyV6jUEEKC9MeY4',
    minIntervalHours: config.minIntervalHours || 2,
    maxIntervalHours: config.maxIntervalHours || 6,
    nextPostTime: config.nextPostTime || null,
    isPollingActive: config.isPollingActive ?? true,
    blueskyUsername: config.blueskyUsername || '',
    blueskyPassword: config.blueskyPassword || '',
    blueskyEnabled: config.blueskyEnabled ?? false,
    twitterApiKey: config.twitterApiKey || '',
    twitterApiSecret: config.twitterApiSecret || '',
    twitterAccessToken: config.twitterAccessToken || '',
    twitterAccessSecret: config.twitterAccessSecret || '',
    twitterEnabled: config.twitterEnabled ?? false,
    webhookUrl: config.webhookUrl || '',
    webhookEnabled: config.webhookEnabled ?? false,
    backendUrl: config.backendUrl || '',
  });

  const [activeTab, setActiveTab] = useState<'drive' | 'bluesky' | 'twitter' | 'notifications'>('drive');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : (type === 'number' ? Number(value) : value),
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <div className="glass rounded-2xl shadow-sm overflow-hidden" id="config-manager-card">
      <div className="border-b border-brand-gold/15 bg-black/30 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-brand-gold" />
          <h2 className="font-display font-medium text-text-main text-lg">System Configuration</h2>
        </div>
        <span className="text-xs font-mono bg-brand-gold/10 text-brand-gold px-2.5 py-1 rounded-full flex items-center gap-1 border border-brand-gold/20">
          <Shield className="w-3.5 h-3.5" /> Encrypted Storage
        </span>
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Tab Selector */}
        <div className="border-r border-brand-gold/10 w-full md:w-56 p-2 space-y-1 bg-black/15">
          <button
            type="button"
            onClick={() => setActiveTab('drive')}
            className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer ${
              activeTab === 'drive'
                ? 'bg-brand-gold/15 text-brand-gold border border-brand-gold/10'
                : 'text-stone-400 hover:bg-black/40 hover:text-text-main'
            }`}
          >
            <Database className="w-4 h-4" />
            Drive & Server API
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('bluesky')}
            className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer ${
              activeTab === 'bluesky'
                ? 'bg-brand-gold/15 text-brand-gold border border-brand-gold/10'
                : 'text-stone-400 hover:bg-black/40 hover:text-text-main'
            }`}
          >
            <Layers className="w-4 h-4" />
            Bluesky Platform
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('twitter')}
            className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer ${
              activeTab === 'twitter'
                ? 'bg-brand-gold/15 text-brand-gold border border-brand-gold/10'
                : 'text-stone-400 hover:bg-black/40 hover:text-text-main'
            }`}
          >
            <Key className="w-4 h-4" />
            X / Twitter API
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notifications')}
            className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer ${
              activeTab === 'notifications'
                ? 'bg-brand-gold/15 text-brand-gold border border-brand-gold/10'
                : 'text-stone-400 hover:bg-black/40 hover:text-text-main'
            }`}
          >
            <RefreshCw className="w-4 h-4" />
            Notifier / Poller
          </button>
        </div>

        {/* Tab content */}
        <form onSubmit={handleSubmit} className="flex-1 p-6 space-y-6">
          {activeTab === 'drive' && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-text-main font-display">Google Drive Directory</h3>
              <p className="text-xs text-text-muted leading-relaxed">
                Provide your custom parent Google Drive folder ID containing content packages. The default points to your shared content directory.
              </p>

              <div>
                <label className="block text-xs font-semibold text-brand-gold mb-1">FOLDER ID</label>
                <input
                  type="text"
                  name="driveFolderId"
                  value={formData.driveFolderId}
                  onChange={handleChange}
                  required
                  placeholder="e.g. 1hsvMRVzXYXjadHot1PyV6jUEEKC9MeY4"
                  className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none transition-all font-mono"
                />
              </div>

              <div className="border-t border-brand-gold/10 pt-4 space-y-2">
                <h3 className="text-sm font-semibold text-text-main font-display">Remote Backend API URL</h3>
                <p className="text-xs text-text-muted leading-relaxed">
                  When deployed statically to web hosting platforms (e.g., Firebase Hosting), the client must point to a live containerized server to proxy Drive & Gemini requests.
                </p>
                <div>
                  <label className="block text-xs font-semibold text-brand-gold mb-1">DEDICATED SERVICE ENDPOINT</label>
                  <input
                    type="text"
                    name="backendUrl"
                    value={formData.backendUrl}
                    onChange={handleChange}
                    placeholder="e.g. https://ais-pre-ers6nylkkq3olbv6aomyji-174790136982.us-west2.run.app"
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none transition-all font-mono text-xs"
                  />
                  <div className="mt-1 text-[10px] text-text-muted font-sans flex items-center gap-1">
                    <span>💡 Leaving this blank uses local relative routing inside the AI Studio container development environment.</span>
                  </div>
                </div>
              </div>

              <div className="bg-black/40 rounded-xl p-4 border border-brand-gold/10 text-xs text-text-muted space-y-2">
                <span className="font-semibold block text-brand-gold">💡 Custom Folder Rules:</span>
                <p>When files are posted, they will be moved to a <code className="bg-stone-900 border border-brand-gold/10 rounded px-1.5 py-0.5 text-brand-gold">posted</code> subdirectory. Skipped items go into <code className="bg-stone-900 border border-brand-gold/10 rounded px-1.5 py-0.5 text-brand-gold">skipped</code>. These are created automatically.</p>
              </div>
            </div>
          )}

          {activeTab === 'bluesky' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-main font-display">Bluesky Configuration</h3>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    name="blueskyEnabled"
                    checked={formData.blueskyEnabled}
                    onChange={handleChange}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-stone-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-stone-950 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-gold"></div>
                  <span className="ml-2 text-xs font-medium text-text-muted">Enable</span>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-text-main mb-1">HANDLE / USERNAME</label>
                  <input
                    type="text"
                    name="blueskyUsername"
                    value={formData.blueskyUsername}
                    onChange={handleChange}
                    disabled={!formData.blueskyEnabled}
                    placeholder="e.g. user.bsky.social"
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none disabled:bg-stone-900/50 transition-all font-sans"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-text-main mb-1">APP PASSWORD</label>
                  <input
                    type="password"
                    name="blueskyPassword"
                    value={formData.blueskyPassword}
                    onChange={handleChange}
                    disabled={!formData.blueskyEnabled}
                    placeholder="••••••••••••••••"
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none disabled:bg-stone-900/50 transition-all font-mono"
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'twitter' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-main font-display">X / Twitter API Credentials</h3>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    name="twitterEnabled"
                    checked={formData.twitterEnabled}
                    onChange={handleChange}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-stone-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-stone-950 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-gold"></div>
                  <span className="ml-2 text-xs font-medium text-text-muted">Enable</span>
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-brand-gold mb-1 font-mono">CONSUMER API KEY</label>
                  <input
                    type="password"
                    name="twitterApiKey"
                    value={formData.twitterApiKey}
                    onChange={handleChange}
                    disabled={!formData.twitterEnabled}
                    placeholder="API Key"
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none disabled:bg-stone-900/50 transition-all font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brand-gold mb-1 font-mono">CONSUMER API SECRET</label>
                  <input
                    type="password"
                    name="twitterApiSecret"
                    value={formData.twitterApiSecret}
                    onChange={handleChange}
                    disabled={!formData.twitterEnabled}
                    placeholder="API Secret"
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none disabled:bg-stone-900/50 transition-all font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brand-gold mb-1 font-mono font-bold">USER ACCESS TOKEN</label>
                  <input
                    type="password"
                    name="twitterAccessToken"
                    value={formData.twitterAccessToken}
                    onChange={handleChange}
                    disabled={!formData.twitterEnabled}
                    placeholder="Access Token"
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none disabled:bg-stone-900/50 transition-all font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brand-gold mb-1 font-mono font-bold">USER ACCESS SECRET</label>
                  <input
                    type="password"
                    name="twitterAccessSecret"
                    value={formData.twitterAccessSecret}
                    onChange={handleChange}
                    disabled={!formData.twitterEnabled}
                    placeholder="Access Secret"
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none disabled:bg-stone-900/50 transition-all font-mono text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-text-main font-display">Scheduler & Phone Notifier</h3>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-brand-gold mb-1">MIN RANGE (HOURS)</label>
                  <input
                    type="number"
                    name="minIntervalHours"
                    value={formData.minIntervalHours}
                    onChange={handleChange}
                    min={1}
                    max={168}
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none transition-all font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brand-gold mb-1">MAX RANGE (HOURS)</label>
                  <input
                    type="number"
                    name="maxIntervalHours"
                    value={formData.maxIntervalHours}
                    onChange={handleChange}
                    min={1}
                    max={168}
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none transition-all font-mono"
                  />
                </div>
              </div>

              <div className="border-t border-brand-gold/10 pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="block text-xs font-semibold text-text-main">PHONE WEBHOOK NOTIFIER</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      name="webhookEnabled"
                      checked={formData.webhookEnabled}
                      onChange={handleChange}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-stone-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-stone-900 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-active-glow peer-checked:bg-brand-gold"></div>
                  </label>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs text-text-muted">WEBHOOK NOTIFY URL (Slack/Discord/Ntfy.sh)</label>
                  <input
                    type="text"
                    name="webhookUrl"
                    value={formData.webhookUrl}
                    onChange={handleChange}
                    disabled={!formData.webhookEnabled}
                    placeholder="e.g. https://ntfy.sh/your_custom_secret_topic"
                    className="w-full text-sm bg-black/35 text-text-main border-brand-gold/15 border rounded-xl px-3.5 py-2.5 focus:border-brand-gold focus:ring-1 focus:ring-brand-gold outline-none disabled:bg-stone-900/50 transition-all font-mono text-xs"
                  />
                </div>
                <p className="text-[10px] text-text-muted">
                  Tip: Put a unique topic here (e.g., <code className="bg-stone-950 border border-brand-gold/10 px-1 py-0.5 rounded text-brand-gold">https://ntfy.sh/gdrive-social-poster-1234</code>) and install the free Ntfy app on your phone to get instant push notifications!
                </p>
              </div>
            </div>
          )}

          <div className="border-t border-brand-gold/10 pt-5 flex items-center justify-end">
            <button
              type="submit"
              disabled={isLoading}
              className="px-5 py-2.5 btn-gold font-bold text-xs rounded-xl disabled:opacity-50 transition-all flex items-center gap-2 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {isLoading ? 'Saving Configuration...' : 'Save and Lock Keys'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
