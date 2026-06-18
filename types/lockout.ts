export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}
