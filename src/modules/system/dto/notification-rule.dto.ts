import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

const TRIGGERS = ['anomaly_high', 'churn_spike', 'rep_offline', 'overdue'];
const CHANNELS = ['email', 'sms', 'whatsapp', 'push'];

export class CreateNotificationRuleDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiProperty({ enum: TRIGGERS })
  @IsIn(TRIGGERS)
  trigger!: 'anomaly_high' | 'churn_spike' | 'rep_offline' | 'overdue';

  @ApiProperty({ enum: CHANNELS })
  @IsIn(CHANNELS)
  channel!: 'email' | 'sms' | 'whatsapp' | 'push';

  @ApiPropertyOptional({ description: 'Trigger-specific params' })
  @IsOptional()
  @IsObject()
  threshold?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String], description: 'Recipient user UUIDs' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  recipients?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateNotificationRuleDto extends PartialType(CreateNotificationRuleDto) {}
