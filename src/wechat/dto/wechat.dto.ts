// 扫码状态枚举
export enum QrCodeStatus {
  PENDING = 'pending', // 等待扫码
  SCANNED = 'scanned', // 已扫码
  CONFIRMED = 'confirmed', // 已确认
  EXPIRED = 'expired', // 已过期
}

// 二维码状态存储
export interface QrCodeState {
  id: string;
  status: QrCodeStatus;
  openid?: string;
  username?: string;
  expireTime: number;
  createdAt: number;
}
