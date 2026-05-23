import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from './entities/notification-rule.entity';

export interface OutboundNotification {
  channel: NotificationChannel;
  recipients: string[];
  subject: string;
  body: string;
  meta?: Record<string, unknown>;
}

/**
 * Sends notifications per channel. v1 ships log-only adapters; swap in real
 * implementations (Nodemailer/Twilio/Meta Cloud/FCM) by replacing the channel
 * handlers — the dispatch interface stays the same.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  async dispatch(n: OutboundNotification): Promise<{ delivered: boolean; channel: NotificationChannel }> {
    // Each branch is the seam where a real provider plugs in.
    switch (n.channel) {
      case 'email':
      case 'sms':
      case 'whatsapp':
      case 'push':
      default:
        this.logger.log(
          `[${n.channel}] → ${n.recipients.join(', ') || '(no recipients)'} :: ${n.subject} :: ${n.body}`,
        );
        return { delivered: true, channel: n.channel };
    }
  }
}
