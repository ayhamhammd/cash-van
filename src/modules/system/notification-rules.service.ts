import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationRule } from './entities/notification-rule.entity';
import {
  CreateNotificationRuleDto,
  UpdateNotificationRuleDto,
} from './dto/notification-rule.dto';
import { RuleEvaluator } from './rule-evaluator.service';

@Injectable()
export class NotificationRulesService {
  constructor(
    @InjectRepository(NotificationRule)
    private readonly rules: Repository<NotificationRule>,
    private readonly evaluator: RuleEvaluator,
  ) {}

  list(): Promise<NotificationRule[]> {
    return this.rules.find({ order: { createdAt: 'DESC' } });
  }

  create(dto: CreateNotificationRuleDto): Promise<NotificationRule> {
    return this.rules.save(
      this.rules.create({
        name: dto.name,
        trigger: dto.trigger,
        channel: dto.channel,
        threshold: dto.threshold ?? null,
        recipients: dto.recipients ?? [],
        isActive: dto.isActive ?? true,
      }),
    );
  }

  async update(id: string, dto: UpdateNotificationRuleDto): Promise<NotificationRule> {
    const rule = await this.getOne(id);
    Object.assign(rule, dto);
    return this.rules.save(rule);
  }

  async remove(id: string): Promise<void> {
    const res = await this.rules.delete({ id });
    if (!res.affected) throw new NotFoundException(`Notification rule ${id} not found`);
  }

  /** Fires the rule's trigger immediately with a synthetic payload. */
  async test(id: string): Promise<{ matched: number }> {
    const rule = await this.getOne(id);
    const matched = await this.evaluator.evaluate(rule.trigger, {
      test: true,
      ruleId: rule.id,
      at: new Date().toISOString(),
    });
    return { matched };
  }

  private async getOne(id: string): Promise<NotificationRule> {
    const rule = await this.rules.findOne({ where: { id } });
    if (!rule) throw new NotFoundException(`Notification rule ${id} not found`);
    return rule;
  }
}
