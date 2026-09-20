import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Shift } from './entities/shift.entity';
import { Rep } from '../reps/entities/rep.entity';
import { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';

@Injectable()
export class ShiftsService {
  constructor(
    @InjectRepository(Shift) private readonly shifts: Repository<Shift>,
    @InjectRepository(Rep) private readonly reps: Repository<Rep>,
  ) {}

  /**
   * Open a day.
   *
   * Two things can make this a no-op rather than a new row, and they mean
   * different things. A repeated clientRef is the SAME open arriving twice —
   * answered 409 with the original, which the handset reads as success. An
   * already-open shift with a different ref is a DIFFERENT open on a day that
   * never closed; that is a real conflict, and silently opening a second one
   * would count the day twice.
   */
  async open(dto: OpenShiftDto): Promise<Shift> {
    if (!(await this.reps.exist({ where: { id: dto.repId } }))) {
      throw new BadRequestException(`Rep ${dto.repId} not found`);
    }

    if (dto.clientRef) {
      const seen = await this.shifts.findOne({ where: { clientRef: dto.clientRef } });
      if (seen) {
        throw new ConflictException({
          message: 'This shift has already been opened',
          code: 'duplicate_client_ref',
          shiftId: seen.id,
        });
      }
    }

    const open = await this.shifts.findOne({
      where: { repId: dto.repId, closedAt: IsNull() },
    });
    if (open) {
      throw new ConflictException({
        message: 'This rep already has an open shift',
        code: 'shift_already_open',
        shiftId: open.id,
        openedAt: open.openedAt,
      });
    }

    return this.shifts.save(
      this.shifts.create({
        repId: dto.repId,
        clientRef: dto.clientRef ?? null,
        // The handset's moment, not ours — see the entity.
        openedAt: dto.openedAt ? new Date(dto.openedAt) : new Date(),
        openLat: dto.openLat ?? null,
        openLng: dto.openLng ?? null,
        note: dto.note ?? null,
      }),
    );
  }

  /**
   * Close the rep's open day.
   *
   * Closing before the open is refused rather than stored: a negative day is
   * not a day, and it would quietly corrupt every duration built on top of it.
   */
  async close(repId: string, dto: CloseShiftDto): Promise<Shift> {
    const shift = await this.shifts.findOne({ where: { repId, closedAt: IsNull() } });
    if (!shift) throw new NotFoundException('This rep has no open shift');

    const closedAt = dto.closedAt ? new Date(dto.closedAt) : new Date();
    if (closedAt < shift.openedAt) {
      throw new BadRequestException(
        `closedAt (${closedAt.toISOString()}) is before the shift opened (${shift.openedAt.toISOString()})`,
      );
    }

    shift.closedAt = closedAt;
    shift.closeLat = dto.closeLat ?? null;
    shift.closeLng = dto.closeLng ?? null;
    if (dto.note) shift.note = dto.note;
    return this.shifts.save(shift);
  }

  /** The rep's open day, or null. What the handset asks on launch. */
  current(repId: string): Promise<Shift | null> {
    return this.shifts.findOne({ where: { repId, closedAt: IsNull() } });
  }

  /** Most recent first — what the office looks at. */
  list(repId: string, limit = 50): Promise<Shift[]> {
    return this.shifts.find({
      where: { repId },
      order: { openedAt: 'DESC' },
      take: Math.min(limit, 200),
    });
  }
}
