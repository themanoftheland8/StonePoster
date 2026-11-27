import React, { useState, useEffect } from 'react';
import { UserConfig } from '../types';
import {
  Save,
  Key,
  Database,
  Bell,
  Layers,
  Copy,
  Check,
  Send,
  ChevronDown,
} from 'lucide-react';
import { isWebPushSupported } from '../lib/webPush';

interface ConfigManagerProps {
  config: UserConfig;
  onSave: (newConfig: UserConfig) => void;
  isLoading: boolean;
  serviceAccountEmail: string | null;
  isThisDeviceSubscribed: boolean;
  subscribedDeviceCount: number;
  isPushBusy: boolean;
  onEnablePush: () => Promise<void>;
  onDisablePush: () => Promise<void>;
  onTestPush: () => Promise<void>;
}

function Toggle({
  name,
  checked,
  onChange,
  label,
}: {
  name: string;
  checked: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label?: string;
}) {
  return (
    <label className="relative inline-flex items-center cursor-pointer gap-2.5">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={onChange}
        className="sr-only peer"
      />
      <div className="w-10 h-5.5 bg-zinc-800 border border-white/10 rounded-full peer peer-checked:bg-amber-500 transition-colors after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-[18px]" />
      {label && <span className="text-xs font-medium text-zinc-400">{label}</span>}
    </label>
  );
}

export default function ConfigManager({
  config,
  onSave,
  isLoading,
  serviceAccountEmail,
  isThisDeviceSubscribed,
  subscribedDeviceCount,
  isPushBusy,
  onEnablePush,
  onDisablePush,
  onTestPush,
}: ConfigManagerProps) {
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
    pushNotificationsEnabled: config.pushNotificationsEnabled ?? true,
    backendUrl: config.backendUrl || '',
  });

  useEffect(() => {
    setFormData({
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
      pushNotificationsEnabled: config.pushNotificationsEnabled ?? true,
      backendUrl: config.backendUrl || '',
    });
  }, [config]);

  const [activeTab, setActiveTab] = useState<'drive' | 'bluesky' | 'twitter' | 'notifications'>('drive');
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [showAdvancedDrive, setShowAdvancedDrive] = useState(Boolean(config.backendUrl));
  const [showWebhook, setShowWebhook] = useState(Boolean(config.webhookEnabled || config.webhookUrl));

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : type === 'number' ? Number(value) : value,
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  const handleCopyServiceEmail = () => {
    if (!serviceAccountEmail) return;
    navigator.clipboard.writeText(serviceAccountEmail);
    setCopiedEmail(true);
    setTimeout(() => setCopiedEmail(false), 2000);
  };

  const pushSupported = isWebPushSupported();

  const tabs: Array<{ id: typeof activeTab; label: string; icon: React.ReactNode }> = [
    { id: 'drive', label: 'Google Drive', icon: <Database className="w-4 h-4" /> },
    { id: 'bluesky', label: 'Bluesky', icon: <Layers className="w-4 h-4" /> },
    { id: 'twitter', label: 'X / Twitter', icon: <Key className="w-4 h-4" /> },
    { id: 'notifications', label: 'Schedule & Push', icon: <Bell className="w-4 h-4" /> },
  ];

  const inputClass =
    'w-full text-sm bg-black/40 text-zinc-100 border border-white/10 rounded-xl px-3.5 py-2.5 focus:border-amber-400/70 focus:ring-1 focus:ring-amber-400/30 outline-none disabled:opacity-40 transition placeholder:text-zinc-600';

  return (
    <div className="bg-surface-dark border border-white/10 rounded-2xl overflow-hidden" id="config-manager-card">
      <div className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-zinc-100 text-base">Settings</h2>
          <p className="text-xs text-zinc-500 mt-0.5">Configure Drive, social accounts, and notifications</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Section tabs */}
        <div className="border-b md:border-b-0 md:border-r border-white/10 w-full md:w-52 p-2.5 flex md:flex-col gap-1 overflow-x-auto no-scrollbar bg-black/20 shrink-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3.5 py-2 rounded-lg text-xs font-medium flex items-center gap-2.5 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                activeTab === t.id
                  ? 'bg-white/10 text-zinc-100'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Form content */}
        <form onSubmit={handleSubmit} className="flex-1 p-6 space-y-6">
          {activeTab === 'drive' && (
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Google Drive Folder ID
                </label>
                <input
                  type="text"
                  name="driveFolderId"
                  value={formData.driveFolderId}
                  onChange={handleChange}
                  required
                  placeholder="e.g. 1hsvMRVzXYXjadHot1PyV6jUEEKC9MeY4"
                  className={`${inputClass} font-mono text-xs`}
                />
                <p className="text-xs text-zinc-500 mt-1.5">
                  Published and skipped files are automatically moved to <code className="text-zinc-300">posted</code> and <code className="text-zinc-300">skipped</code> subfolders.
                </p>
              </div>

              {/* 24/7 Service Account Folder Sharing */}
              <div className="bg-white/[0.03] rounded-xl p-4 border border-white/10 text-xs space-y-2.5">
                <p className="font-medium text-zinc-200">24/7 Background Access</p>
                <p className="text-zinc-400 leading-relaxed">
                  Share your Google Drive folder (<strong className="text-zinc-200">Editor</strong> permission) with this service account so the cloud scheduler can read media and archive posts while your browser is closed:
                </p>
                {serviceAccountEmail ? (
                  <div className="flex items-center gap-2 bg-black/50 border border-white/10 rounded-lg px-3 py-2">
                    <code className="text-xs text-amber-300 font-mono truncate flex-1 select-all">
                      {serviceAccountEmail}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyServiceEmail}
                      className="px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/15 text-zinc-100 font-medium text-xs flex items-center gap-1 shrink-0 cursor-pointer transition"
                    >
                      {copiedEmail ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedEmail ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500 font-mono">
                    Service account email loads once connected to the deployed backend.
                  </p>
                )}
              </div>

              <div className="border-t border-white/10 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAdvancedDrive(v => !v)}
                  className="text-xs font-medium text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5 cursor-pointer"
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdvancedDrive ? 'rotate-180' : ''}`} />
                  Advanced API Endpoint
                </button>
                {showAdvancedDrive && (
                  <div className="mt-3 space-y-1.5">
                    <label className="block text-xs font-medium text-zinc-400">
                      Custom Backend URL (optional)
                    </label>
                    <input
                      type="text"
                      name="backendUrl"
                      value={formData.backendUrl}
                      onChange={handleChange}
                      placeholder="Leave blank to use /api/** rewrites"
                      className={`${inputClass} font-mono text-xs`}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'bluesky' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-zinc-100">Bluesky Account</h3>
                  <p className="text-xs text-zinc-500">Post directly via ATProto</p>
                </div>
                <Toggle
                  name="blueskyEnabled"
                  checked={formData.blueskyEnabled}
                  onChange={handleChange}
                  label={formData.blueskyEnabled ? 'Enabled' : 'Disabled'}
                />
              </div>

              <div className="space-y-3.5 pt-2">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Full Handle</label>
                  <input
                    type="text"
                    name="blueskyUsername"
                    value={formData.blueskyUsername}
                    onChange={handleChange}
                    disabled={!formData.blueskyEnabled}
                    placeholder="yourname.bsky.social"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">App Password</label>
                  <input
                    type="password"
                    name="blueskyPassword"
                    value={formData.blueskyPassword}
                    onChange={handleChange}
                    disabled={!formData.blueskyEnabled}
                    placeholder="xxxx-xxxx-xxxx-xxxx"
                    className={`${inputClass} font-mono`}
                  />
                  <p className="text-xs text-zinc-500 mt-1.5">
                    Generate in Bluesky under Settings → Privacy and security → App passwords.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'twitter' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-zinc-100">X / Twitter Account</h3>
                  <p className="text-xs text-zinc-500">OAuth 1.0a user context keys</p>
                </div>
                <Toggle
                  name="twitterEnabled"
                  checked={formData.twitterEnabled}
                  onChange={handleChange}
                  label={formData.twitterEnabled ? 'Enabled' : 'Disabled'}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 pt-2">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Consumer API Key</label>
                  <input
                    type="password"
                    name="twitterApiKey"
                    value={formData.twitterApiKey}
                    onChange={handleChange}
                    disabled={!formData.twitterEnabled}
                    placeholder="API Key"
                    className={`${inputClass} font-mono text-xs`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Consumer API Secret</label>
                  <input
                    type="password"
                    name="twitterApiSecret"
                    value={formData.twitterApiSecret}
                    onChange={handleChange}
                    disabled={!formData.twitterEnabled}
                    placeholder="API Secret"
                    className={`${inputClass} font-mono text-xs`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Access Token</label>
                  <input
                    type="password"
                    name="twitterAccessToken"
                    value={formData.twitterAccessToken}
                    onChange={handleChange}
                    disabled={!formData.twitterEnabled}
                    placeholder="Access Token"
                    className={`${inputClass} font-mono text-xs`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Access Secret</label>
                  <input
                    type="password"
                    name="twitterAccessSecret"
                    value={formData.twitterAccessSecret}
                    onChange={handleChange}
                    disabled={!formData.twitterEnabled}
                    placeholder="Access Secret"
                    className={`${inputClass} font-mono text-xs`}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-zinc-100">Background Polling</h3>
                  <p className="text-xs text-zinc-500">Checks Drive on a random interval 24/7</p>
                </div>
                <Toggle
                  name="isPollingActive"
                  checked={formData.isPollingActive}
                  onChange={handleChange}
                  label={formData.isPollingActive ? 'Active' : 'Paused'}
                />
              </div>

              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Min Interval (hours)</label>
                  <input
                    type="number"
                    name="minIntervalHours"
                    value={formData.minIntervalHours}
                    onChange={handleChange}
                    min={1}
                    max={168}
                    className={`${inputClass} font-mono`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">Max Interval (hours)</label>
                  <input
                    type="number"
                    name="maxIntervalHours"
                    value={formData.maxIntervalHours}
                    onChange={handleChange}
                    min={1}
                    max={168}
                    className={`${inputClass} font-mono`}
                  />
                </div>
              </div>

              {/* Chrome Web Push Section */}
              <div className="border-t border-white/10 pt-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-zinc-100">Chrome Push Notifications</h3>
                    <p className="text-xs text-zinc-500">Alert this device when a draft is ready</p>
                  </div>
                  <Toggle
                    name="pushNotificationsEnabled"
                    checked={formData.pushNotificationsEnabled ?? true}
                    onChange={handleChange}
                  />
                </div>

                <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-zinc-400">
                      This device:{' '}
                      <strong className={isThisDeviceSubscribed ? 'text-emerald-400' : 'text-amber-300'}>
                        {!pushSupported
                          ? 'Unsupported browser'
                          : isThisDeviceSubscribed
                            ? 'Subscribed'
                            : 'Not enabled'}
                      </strong>
                    </span>
                    <span className="text-xs font-mono text-zinc-400">
                      {subscribedDeviceCount} device{subscribedDeviceCount === 1 ? '' : 's'} total
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {pushSupported && (
                      <button
                        type="button"
                        onClick={isThisDeviceSubscribed ? onDisablePush : onEnablePush}
                        disabled={isPushBusy}
                        className={`px-3.5 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                          isThisDeviceSubscribed
                            ? 'bg-white/5 border border-white/10 text-zinc-300 hover:bg-red-500/10 hover:text-red-300 hover:border-red-500/30'
                            : 'btn-gold'
                        }`}
                      >
                        <Bell className="w-3.5 h-3.5" />
                        {isPushBusy
                          ? 'Working...'
                          : isThisDeviceSubscribed
                            ? 'Disable on This Device'
                            : 'Enable Chrome Notifications'}
                      </button>
                    )}

                    {subscribedDeviceCount > 0 && (
                      <button
                        type="button"
                        onClick={onTestPush}
                        disabled={isPushBusy}
                        className="px-3.5 py-2 rounded-lg text-xs font-medium btn-gold-outline flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                      >
                        <Send className="w-3.5 h-3.5" />
                        Send Test Notification
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Optional Webhook */}
              <div className="border-t border-white/10 pt-4">
                <button
                  type="button"
                  onClick={() => setShowWebhook(v => !v)}
                  className="text-xs font-medium text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5 cursor-pointer"
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showWebhook ? 'rotate-180' : ''}`} />
                  Optional Webhook (Slack / Discord / ntfy)
                </button>
                {showWebhook && (
                  <div className="mt-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-400">Enable webhook alerts</span>
                      <Toggle
                        name="webhookEnabled"
                        checked={formData.webhookEnabled}
                        onChange={handleChange}
                      />
                    </div>
                    <input
                      type="text"
                      name="webhookUrl"
                      value={formData.webhookUrl}
                      onChange={handleChange}
                      disabled={!formData.webhookEnabled}
                      placeholder="https://ntfy.sh/your_topic"
                      className={`${inputClass} font-mono text-xs`}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="border-t border-white/10 pt-5 flex items-center justify-end">
            <button
              type="submit"
              disabled={isLoading}
              className="px-5 py-2.5 btn-gold text-xs rounded-xl disabled:opacity-50 flex items-center gap-2 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              {isLoading ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
