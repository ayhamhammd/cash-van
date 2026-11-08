import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { StorageService } from '../../common/storage/storage.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DeliveriesService } from './deliveries.service';
import { DeliveryProof, type DeliveryProofKind } from './entities/delivery-proof.entity';
import { DeliveryRun } from './entities/delivery-run.entity';
import { DeliveryStop } from './entities/delivery-stop.entity';
import type { ProofAudience } from './delivery-views';
import type { SyncDeliveryProofDto } from './dto/deliveries.dto';

/** Contract §B limits. */
export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
export const SIGNATURE_MAX_BYTES = 300 * 1024;
export const MAX_PHOTOS_PER_STOP = 5;
/**
 * Multer's hard ceiling (the ERP's own attachment cap). Above the per-kind
 * limits on purpose: a 4 MB photo is then refused here as 422 FILE_TOO_LARGE,
 * with a code the phone can act on, rather than as multer's bare 413.
 */
export const PROOF_UPLOAD_CEILING = 10 * 1024 * 1024;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * What the bytes ARE, from their first bytes — never from the name or the
 * Content-Type the phone claims. Null for anything that is not JPEG/PNG/WebP.
 */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * The type a proof may be, or the code it is refused with. A photo is
 * JPEG/PNG/WebP up to 3 MB; a signature is a PNG up to 300 KB.
 */
export function checkProofFile(
  kind: DeliveryProofKind,
  buf: Buffer,
): { mime: string } | { code: 'UNSUPPORTED_TYPE' | 'FILE_TOO_LARGE' | 'FILE_EMPTY' } {
  if (!buf?.length) return { code: 'FILE_EMPTY' };
  const mime = sniffImage(buf);
  if (kind === 'SIGNATURE') {
    if (mime !== 'image/png') return { code: 'UNSUPPORTED_TYPE' };
    if (buf.length > SIGNATURE_MAX_BYTES) return { code: 'FILE_TOO_LARGE' };
    return { mime };
  }
  if (!mime) return { code: 'UNSUPPORTED_TYPE' };
  if (buf.length > PHOTO_MAX_BYTES) return { code: 'FILE_TOO_LARGE' };
  return { mime };
}

/**
 * Delivery proofs: the photos and the signature the phone uploads before its
 * result (`POST sync/delivery-proofs`), and the routes that stream them back.
 *
 * Idempotent on the phone's clientRef: the same ref again answers the proof it
 * already made (200 instead of 201), whatever file came with it. The file is
 * this server's own copy; the ERP gets one through the outbox once a result
 * that names the proof is accepted.
 */
@Injectable()
export class DeliveryProofsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(DeliveryProof) private readonly proofs: Repository<DeliveryProof>,
    @InjectRepository(DeliveryStop) private readonly stops: Repository<DeliveryStop>,
    @InjectRepository(DeliveryRun) private readonly runs: Repository<DeliveryRun>,
    private readonly storage: StorageService,
    private readonly deliveries: DeliveriesService,
  ) {}

  async upload(
    file: Express.Multer.File | undefined,
    dto: SyncDeliveryProofDto,
    actor: AuthenticatedUser,
  ): Promise<{ created: boolean; proofId: string; clientRef: string }> {
    await this.deliveries.requireDeliveryRep(actor);
    const clientRef = dto.clientRef.trim();
    const seen = await this.proofs.findOne({ where: { clientRef } });
    if (seen) return { created: false, proofId: seen.id, clientRef };

    const stop = await this.stops.findOne({ where: { id: dto.stopId } });
    if (!stop) {
      throw new NotFoundException({ message: `Stop ${dto.stopId} not found`, code: 'STOP_NOT_FOUND' });
    }
    const checked = checkProofFile(dto.kind, file?.buffer ?? Buffer.alloc(0));
    if ('code' in checked) {
      throw new UnprocessableEntityException({
        message:
          dto.kind === 'SIGNATURE'
            ? 'A signature is a PNG of at most 300 KB'
            : 'A photo is a JPEG, PNG or WebP of at most 3 MB',
        code: checked.code,
      });
    }

    const key = `deliveries/${stop.id}/${clientRef}.${EXT[checked.mime]}`;
    // Written before the row: a row never points at a file that is not there.
    // Two uploads of one ref racing write the same bytes to the same key.
    await this.storage.save(key, file!.buffer);

    return this.dataSource.transaction(async (em) => {
      // One writer per stop, so the photo count cannot be raced past 5.
      await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`delivery_proofs:${stop.id}`]);
      const again: Array<{ id: string }> = await em.query(
        `SELECT id FROM delivery_proofs WHERE client_ref = $1`,
        [clientRef],
      );
      if (again[0]) return { created: false, proofId: again[0].id, clientRef };
      if (dto.kind === 'PHOTO') {
        const [{ n }]: Array<{ n: number }> = await em.query(
          `SELECT count(*)::int AS n FROM delivery_proofs WHERE stop_id = $1 AND kind = 'PHOTO'`,
          [stop.id],
        );
        if (n >= MAX_PHOTOS_PER_STOP) {
          throw new UnprocessableEntityException({
            message: `A stop takes at most ${MAX_PHOTOS_PER_STOP} photos`,
            code: 'TOO_MANY_PHOTOS',
          });
        }
      }
      const [row]: Array<{ id: string }> = await em.query(
        `INSERT INTO delivery_proofs
           (client_ref, stop_id, kind, storage_key, mime, size_bytes, captured_at, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          clientRef,
          stop.id,
          dto.kind,
          key,
          checked.mime,
          file!.buffer.length,
          dto.capturedAt ? new Date(dto.capturedAt) : null,
          actor.sub ?? null,
        ],
      );
      return { created: true, proofId: row.id, clientRef };
    });
  }

  /**
   * The file of one proof of one stop. The phone may read only proofs of stops
   * on its own runs; the dashboard route is gated by `deliveries.view`.
   */
  async file(
    stopId: string,
    proofId: string,
    audience: ProofAudience,
    actor?: AuthenticatedUser,
  ): Promise<{ buffer: Buffer; mime: string; filename: string }> {
    if (audience === 'phone') {
      const rep = await this.deliveries.requireDeliveryRep(actor!);
      const stop = await this.stops.findOne({ where: { id: stopId } });
      const run = stop ? await this.runs.findOne({ where: { id: stop.runId } }) : null;
      if (!run || run.repId !== rep.id) throw new NotFoundException(`Proof ${proofId} not found`);
    }
    const proof = await this.proofs.findOne({ where: { id: proofId, stopId } });
    if (!proof) throw new NotFoundException(`Proof ${proofId} not found`);
    const buffer = await this.storage.read(proof.storageKey).catch(() => null);
    if (!buffer) throw new NotFoundException(`The file of proof ${proofId} is missing`);
    const ext = EXT[proof.mime] ?? 'bin';
    return { buffer, mime: proof.mime, filename: `${proof.kind.toLowerCase()}-${proof.id}.${ext}` };
  }
}
