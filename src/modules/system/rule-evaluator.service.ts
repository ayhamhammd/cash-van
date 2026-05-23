import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';

import {
  NotificationRule,
  NotificationTrigger,
} from './entities/notification-rule.entity';
import { NotificationDispatcher } from './notification-dispatcher.service';

/**
 * Translates domain events into notifications by matching active rules.
 *
 * Listeners are wired for all four spec triggers; their sources arrive with
 * later plans (anomaly = plan 08, rep.offline = plan 10, overdue/churn = crons).
 * Until then, `evaluate()` is exercised directly by the rule "test" endpoint.
 */
@Injectable()
export class RuleEvaluator {
  private readonly logger = new Logger(RuleEvaluator.name);

  constructor(
    @InjectRepository(NotificationRule)
    private readonly rules: Repository<NotificationRule>,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async evaluate(
    trigger: NotificationTrigger,
    payload: Record<string, unknown>,
  ): Promise<number> {
    const active = await this.rules.find({ where: { trigger, isActive: true } });
    for (const rule of active) {
      await this.dispatcher.dispatch({
        channel: rule.channel,
        recipients: rule.recipients,
        subject: `[VanFlow] ${rule.name}`,
        body: `Trigger '${trigger}' fired: ${JSON.stringify(payload)}`,
        meta: { ruleId: rule.id, trigger },
      });
    }
    if (active.length === 0) {
      this.logger.debug(`No active rules for trigger '${trigger}'`);
    }
    return active.length;
  }

  @OnEvent('invoice.anomaly_flagged')
  onAnomaly(payload: Record<string, unknown>): Promise<number> {
    return this.evaluate('anomaly_high', payload);
  }

  @OnEvent('rep.offline')
  onRepOffline(payload: Record<string, unknown>): Promise<number> {
    return this.evaluate('rep_offline', payload);
  }

  @OnEvent('collection.overdue')
  onOverdue(payload: Record<string, unknown>): Promise<number> {
    return this.evaluate('overdue', payload);
  }

  @OnEvent('customer.churn_spike')
  onChurnSpike(payload: Record<string, unknown>): Promise<number> {
    return this.evaluate('churn_spike', payload);
  }
}
