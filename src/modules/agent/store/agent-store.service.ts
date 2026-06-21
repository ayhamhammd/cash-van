import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { StorageService } from '../../../common/storage/storage.service';
import { AgentConversation } from '../entities/agent-conversation.entity';
import { AgentReport } from '../entities/agent-report.entity';
import type { ReportFormat, ReportRef, StoredMessage } from '../agent.types';

export interface ConversationHandle {
  id: string;
  messages: StoredMessage[];
  isNew: boolean;
}

export interface CreateReportInput {
  conversationId: string | null;
  createdBy: string | null;
  title: string | null;
  format: ReportFormat;
  filename: string;
  contentType: string;
  rowCount: number;
  sqlText: string | null;
  buffer: Buffer;
}

/** Persistence for chat threads and generated report files. */
@Injectable()
export class AgentStoreService {
  constructor(
    @InjectRepository(AgentConversation)
    private readonly conversations: Repository<AgentConversation>,
    @InjectRepository(AgentReport)
    private readonly reports: Repository<AgentReport>,
    private readonly storage: StorageService,
  ) {}

  /** Load an existing thread or start a fresh one. Unknown ids → new thread. */
  async openConversation(
    conversationId: string | undefined,
    createdBy: string | null,
  ): Promise<ConversationHandle> {
    if (conversationId) {
      const existing = await this.conversations.findOne({
        where: { id: conversationId },
      });
      if (existing) {
        return {
          id: existing.id,
          messages: (existing.messages ?? []) as StoredMessage[],
          isNew: false,
        };
      }
    }
    const created = await this.conversations.save(
      this.conversations.create({ createdBy, messages: [] }),
    );
    return { id: created.id, messages: [], isNew: true };
  }

  /** Persist the full message array (and set a title on first save). */
  async saveConversation(
    id: string,
    messages: StoredMessage[],
    title: string | null,
  ): Promise<void> {
    await this.conversations.update(id, {
      messages,
      ...(title ? { title } : {}),
      updatedAt: new Date(),
    });
  }

  /** Store the report bytes + a metadata row, return what the client needs. */
  async createReport(
    input: CreateReportInput,
    extension: string,
  ): Promise<ReportRef> {
    const id = randomUUID();
    const storageKey = `agent-reports/${id}.${extension}`;
    await this.storage.save(storageKey, input.buffer);

    await this.reports.save(
      this.reports.create({
        id,
        conversationId: input.conversationId,
        createdBy: input.createdBy,
        title: input.title,
        format: input.format,
        filename: input.filename,
        storageKey,
        contentType: input.contentType,
        rowCount: input.rowCount,
        sqlText: input.sqlText,
      }),
    );

    return {
      reportId: id,
      title: input.title,
      format: input.format,
      filename: input.filename,
      rowCount: input.rowCount,
      downloadUrl: `/api/v1/agent/reports/${id}`,
    };
  }

  /** Fetch report metadata + bytes for download. */
  async loadReport(
    id: string,
  ): Promise<{ report: AgentReport; buffer: Buffer }> {
    const report = await this.reports.findOne({ where: { id } });
    if (!report) throw new NotFoundException(`Report not found: ${id}`);
    const buffer = await this.storage.read(report.storageKey);
    return { report, buffer };
  }
}
