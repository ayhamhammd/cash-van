import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type ChurnRiskLabel = 'loyal' | 'at_risk' | 'high_risk';

/**
 * AI-enriched customer attributes. Written by the nightly AI pipeline
 * (plan 08). One row per customer (PK = customer_id).
 */
@Entity({ name: 'customer_ai_profile' })
export class CustomerAiProfile {
  @PrimaryColumn({ name: 'customer_id', type: 'uuid' })
  customerId!: string;

  @Index('idx_cap_segment')
  @Column({ type: 'text' })
  segment!: string;

  @Index('idx_cap_churn_score_desc')
  @Column({ name: 'churn_score', type: 'real' })
  churnScore!: number;

  @Column({ name: 'churn_risk_label', type: 'text' })
  churnRiskLabel!: ChurnRiskLabel;

  @Column({ name: 'ltv_estimate', type: 'integer', nullable: true })
  ltvEstimate?: number | null;

  @Column({ name: 'shap_drivers_json', type: 'jsonb', nullable: true })
  shapDriversJson?: Record<string, unknown> | null;

  @Column({ name: 'model_version', type: 'text' })
  modelVersion!: string;

  @Column({ name: 'computed_at', type: 'timestamptz' })
  computedAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
