import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const AI_PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
export const AI_LANGUAGES = ['auto', 'ar', 'en', 'bilingual'] as const;

/** Configure the AI assistant provider + key from Settings (admin only). */
export class UpdateAiDto {
  @ApiProperty({ description: 'Master switch for the settings-driven AI provider.' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ enum: AI_PROVIDERS, description: 'LLM vendor.' })
  @IsOptional()
  @IsIn(AI_PROVIDERS as unknown as string[])
  provider?: string;

  @ApiPropertyOptional({ description: 'Model id (e.g. gpt-4o). Omit ⇒ provider default.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  @ApiPropertyOptional({ description: 'API key; encrypted before storage. Omit to keep the current key.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  apiKey?: string;

  @ApiPropertyOptional({ description: 'Confidence gate 0–100; suggestions below are de-emphasised.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  confidenceThreshold?: number;

  @ApiPropertyOptional({ enum: AI_LANGUAGES })
  @IsOptional()
  @IsIn(AI_LANGUAGES as unknown as string[])
  language?: string;

  @ApiPropertyOptional({ description: 'Per-capability on/off map.' })
  @IsOptional()
  @IsObject()
  capabilities?: Record<string, boolean>;
}
