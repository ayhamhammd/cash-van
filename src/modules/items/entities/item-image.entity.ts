import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * One item's photo, cached from the ERP and served from here.
 *
 * The handset must never have to reach the ERP for a picture: the item URL is
 * built from the ERP's configured base, which is whatever makes the
 * server-to-server sync work and is often unreachable from a phone.
 */
@Entity({ name: 'item_images' })
@Index('uq_item_images_item', ['itemId'], { unique: true })
export class ItemImage extends BaseEntity {
  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  /**
   * The URL these bytes were taken from.
   *
   * Compared against the item's current image URL on every read: when the office
   * replaces a photo the URL changes, and that is how this copy is known to be
   * stale rather than being served for ever.
   */
  @Column({ name: 'source_url', type: 'text' })
  sourceUrl!: string;

  @Column({ type: 'bytea' })
  data!: Buffer;

  @Column({ type: 'bytea', nullable: true })
  thumb?: Buffer | null;

  @Column({ type: 'text' })
  mime!: string;

  @Column({ name: 'byte_size', type: 'integer' })
  byteSize!: number;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;
}
