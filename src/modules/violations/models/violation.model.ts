export type ViolationType =
  | 'TAB_SWITCH'
  | 'FULLSCREEN_EXIT'
  | 'COPY_ATTEMPT'
  | 'PASTE_ATTEMPT'
  | 'RIGHT_CLICK'
  | 'WINDOW_BLUR'
  | 'DEVTOOLS_OPEN'
  | 'NETWORK_DROP';

export class ViolationModel {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly attemptId: string,
    public readonly type: ViolationType,
    public readonly detail: Record<string, unknown> | null,
    public readonly clientTimestamp: Date,
    public readonly serverTimestamp: Date,
  ) {}
}
