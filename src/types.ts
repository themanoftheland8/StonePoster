export interface UserConfig {
  driveFolderId: string;
  minIntervalHours: number;
  maxIntervalHours: number;
  nextPostTime: number | null;
  isPollingActive: boolean;
  blueskyUsername?: string;
  blueskyPassword?: string;
  blueskyEnabled: boolean;
  twitterApiKey?: string;
  twitterApiSecret?: string;
  twitterAccessToken?: string;
  twitterAccessSecret?: string;
  twitterEnabled: boolean;
  webhookUrl?: string;
  webhookEnabled: boolean;
  updatedAt?: number;
}

export interface PostItem {
  id: string;
  driveFileId: string | null;
  fileName: string;
  mimeType: string;
  imageUrl: string;
  captions: string[];
  selectedCaption: string;
  status: 'pending_review' | 'posted' | 'skipped';
  createdAt: number;
  postedAt?: number | null;
  skippedAt?: number | null;
}

export interface LogItem {
  id: string;
  type: 'info' | 'success' | 'error';
  message: string;
  timestamp: number;
}
