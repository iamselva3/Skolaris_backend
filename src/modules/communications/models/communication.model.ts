export type DeliveryChannel = 'EMAIL' | 'SMS' | 'PUSH' | 'WHATSAPP' | 'IN_APP';

export type CommunicationType =
  | 'EXAM_ALERT'
  | 'REPORT_PUBLISHED'
  | 'ATTENDANCE_ALERT'
  | 'FEE_REMINDER'
  | 'CIRCULAR'
  | 'ANNOUNCEMENT'
  | 'GENERAL';

export type CommunicationStatus = 'SENT' | 'FAILED' | 'SCHEDULED' | 'PARTIAL';

export const DELIVERY_CHANNELS: DeliveryChannel[] = ['EMAIL', 'SMS', 'PUSH', 'WHATSAPP', 'IN_APP'];

export const COMMUNICATION_TYPES: CommunicationType[] = [
  'EXAM_ALERT',
  'REPORT_PUBLISHED',
  'ATTENDANCE_ALERT',
  'FEE_REMINDER',
  'CIRCULAR',
  'ANNOUNCEMENT',
  'GENERAL',
];

export const COMMUNICATION_STATUSES: CommunicationStatus[] = [
  'SENT',
  'FAILED',
  'SCHEDULED',
  'PARTIAL',
];

/**
 * A single institution-sent communication (one broadcast to a cohort) as the
 * communication-history view sees it. Distinct from the per-recipient
 * Notification feed — recipient detail is summarised as counts.
 */
export interface CommunicationModel {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  type: CommunicationType;
  channel: DeliveryChannel;
  status: CommunicationStatus;
  audience: string | null;
  recipientCount: number;
  deliveredCount: number;
  failedCount: number;
  sentById: string | null;
  sentByName: string | null;
  scheduledAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
