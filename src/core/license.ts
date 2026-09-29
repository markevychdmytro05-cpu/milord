export interface LicenseState {
  status: 'unlicensed' | 'active' | 'offline' | 'test' | 'blocked' | 'expired' | 'error';
  allowed: boolean;
  message: string;
  serverUrl: string;
  deviceId: string;
  keySuffix?: string;
  maxAccounts?: number;
  maxDevices?: number;
  accountsUsed: number;
  expiresAt?: string | null;
  validUntil?: string;
}
