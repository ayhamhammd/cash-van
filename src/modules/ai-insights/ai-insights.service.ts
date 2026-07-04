import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export type Tone = 'info' | 'warn' | 'good';
export type Trend = 'up' | 'down' | 'flat';

export interface BilingualLine {
  textAr: string;
  textEn: string;
  tone: Tone;
}

export interface AiInsights {
  generatedAt: string;
  briefing: { confidence: number; items: BilingualLine[] };
  forecast: {
    items: { nameAr: string; nameEn: string; d7: Trend; d30: Trend; d90: Trend }[];
  };
  recommendations: {
    items: { nameAr: string; nameEn: string; ratePct: number; coach: boolean }[];
  };
  ocr: { scanned: number; avgConfidence: number; mismatchFlagged: number };
}

/**
 * Live, deterministic AI-style insights computed straight from operational data
 * (posted sales, receivables, rep activity, cheque OCR) — no external model or
 * API key needed. Prose is returned bilingually (ar + en); the UI picks by locale.
 */
@Injectable()
export class AiInsightsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async insights(): Promise<AiInsights> {
    const [briefing, forecast, recommendations, ocr] = await Promise.all([
      this.briefing(),
      this.forecast(),
      this.recommendations(),
      this.ocr(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      briefing,
      forecast,
      recommendations,
      ocr,
    };
  }

  private async briefing(): Promise<AiInsights['briefing']> {
    const [row] = (await this.ds.query(`
      SELECT
        (SELECT COALESCE(SUM(total), 0)::float
           FROM voucher_headers
          WHERE trans_kind = 'SALE' AND is_posted = true
            AND in_date::date = CURRENT_DATE)                         AS today_sales,
        (SELECT COUNT(*)::int FROM customers
          WHERE is_active = true AND deleted_at IS NULL
            AND CAST(total_debt AS numeric) > 0)                      AS at_risk,
        (SELECT COUNT(*)::int FROM cheques WHERE words_match = false) AS flagged
    `)) as { today_sales: number; at_risk: number; flagged: number }[];

    const todaySales = Math.round(Number(row?.today_sales ?? 0));
    const atRisk = Number(row?.at_risk ?? 0);
    const flagged = Number(row?.flagged ?? 0);

    const items: BilingualLine[] = [
      {
        tone: 'good',
        textEn: `Today's posted sales so far: ${todaySales.toLocaleString('en')} JOD.`,
        textAr: `مبيعات اليوم المرحّلة حتى الآن: ${todaySales.toLocaleString('ar-EG')} دينار.`,
      },
      {
        tone: atRisk > 0 ? 'warn' : 'good',
        textEn:
          atRisk > 0
            ? `${atRisk} customer(s) carry an outstanding balance — prioritise collection.`
            : 'No customers with outstanding balances.',
        textAr:
          atRisk > 0
            ? `${atRisk} عميل عليه رصيد مستحق — أعطِ الأولوية للتحصيل.`
            : 'لا يوجد عملاء لديهم أرصدة مستحقة.',
      },
      {
        tone: flagged > 0 ? 'warn' : 'good',
        textEn:
          flagged > 0
            ? `${flagged} cheque(s) flagged for review (amount-in-words mismatch).`
            : 'No cheques flagged for review.',
        textAr:
          flagged > 0
            ? `${flagged} شيك موسوم للمراجعة (عدم تطابق المبلغ كتابةً).`
            : 'لا توجد شيكات موسومة للمراجعة.',
      },
    ];
    return { confidence: 0.92, items };
  }

  private async forecast(): Promise<AiInsights['forecast']> {
    const rows = (await this.ds.query(`
      SELECT vt.item_number,
             MAX(vt.item_name) AS item_name,
             SUM(CASE WHEN vh.in_date > now() - interval '7 days'  THEN CAST(vt.item_qty AS numeric) ELSE 0 END)::float AS d7,
             SUM(CASE WHEN vh.in_date > now() - interval '30 days' THEN CAST(vt.item_qty AS numeric) ELSE 0 END)::float AS d30,
             SUM(CASE WHEN vh.in_date > now() - interval '90 days' THEN CAST(vt.item_qty AS numeric) ELSE 0 END)::float AS d90
        FROM voucher_transactions vt
        JOIN voucher_headers vh ON vh.voucher_number = vt.voucher_number
       WHERE vt.trans_kind = 'SALE' AND vh.is_posted = true
         AND vh.in_date > now() - interval '90 days'
       GROUP BY vt.item_number
       ORDER BY d30 DESC
       LIMIT 6
    `)) as { item_name: string; d7: number; d30: number; d90: number }[];

    return {
      items: rows.map((r) => {
        const d7 = Number(r.d7);
        const d30 = Number(r.d30);
        const d90 = Number(r.d90);
        const older60 = (d90 - d30) / 60;
        return {
          nameAr: r.item_name,
          nameEn: r.item_name,
          d7: cmp(d7 / 7, d30 / 30),
          d30: cmp(d30 / 30, d90 / 90),
          d90: cmp(d30 / 30, older60),
        };
      }),
    };
  }

  private async recommendations(): Promise<AiInsights['recommendations']> {
    const rows = (await this.ds.query(`
      SELECT r.name_ar, r.name_en,
             COALESCE(SUM(CASE WHEN vh.in_date > now() - interval '7 days'
                               THEN CAST(vh.total AS numeric) ELSE 0 END), 0)::float AS sales7d
        FROM reps r
        LEFT JOIN customers c ON c.rep_id = r.id AND c.deleted_at IS NULL
        LEFT JOIN voucher_headers vh ON vh.customer_number = c.customer_number
             AND vh.trans_kind = 'SALE' AND vh.is_posted = true
       WHERE r.is_active = true
       GROUP BY r.id, r.name_ar, r.name_en
       ORDER BY sales7d DESC
       LIMIT 6
    `)) as { name_ar: string; name_en: string | null; sales7d: number }[];

    const max = Math.max(0, ...rows.map((r) => Number(r.sales7d)));
    return {
      items: rows.map((r) => {
        const ratePct = max > 0 ? Math.round((Number(r.sales7d) / max) * 100) : 0;
        return {
          nameAr: r.name_ar,
          nameEn: r.name_en ?? r.name_ar,
          ratePct,
          coach: max > 0 && ratePct < 30,
        };
      }),
    };
  }

  private async ocr(): Promise<AiInsights['ocr']> {
    const [row] = (await this.ds.query(`
      SELECT COUNT(*) FILTER (WHERE ocr_confidence IS NOT NULL)::int             AS scanned,
             COALESCE(AVG(ocr_confidence) FILTER (WHERE ocr_confidence IS NOT NULL), 0)::float AS avg_conf,
             COUNT(*) FILTER (WHERE words_match = false)::int                    AS mismatch
        FROM cheques
    `)) as { scanned: number; avg_conf: number; mismatch: number }[];
    return {
      scanned: Number(row?.scanned ?? 0),
      avgConfidence: Number(row?.avg_conf ?? 0),
      mismatchFlagged: Number(row?.mismatch ?? 0),
    };
  }
}

/** Trend of a recent run-rate vs an older one, with a 10% dead-band. */
function cmp(recent: number, older: number): Trend {
  if (!isFinite(recent) || !isFinite(older)) return 'flat';
  if (older <= 0) return recent > 0 ? 'up' : 'flat';
  const ratio = recent / older;
  if (ratio > 1.1) return 'up';
  if (ratio < 0.9) return 'down';
  return 'flat';
}
