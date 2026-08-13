import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { StockRequest } from './stock-request.entity';

/**
 * One requested item, in the unit the salesman thinks in.
 *
 * Quantities are held twice on purpose. `qtyOfUnit` is what the salesman typed
 * ("4 cartons") and is what both they and the manager read; `baseQty` is the
 * same amount in the stock pool's own units, and is the only figure the transfer
 * and the ERP ever see. Storing only one and converting on the fly would make
 * the displayed number drift the day someone edits the item's units.
 */
@Entity({ name: 'stock_request_items' })
@Index('idx_stock_request_items_request', ['requestId'])
export class StockRequestItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => StockRequest, (r) => r.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request!: StockRequest;

  @Column({ name: 'request_id', type: 'uuid' })
  requestId!: string;

  @Column({ name: 'item_number', type: 'text' })
  itemNumber!: string;

  /** Name snapshot: the manager must see what was asked for, not what it is called today. */
  @Column({ name: 'item_name', type: 'text' })
  itemName!: string;

  /**
   * The stock pool this line draws on: a variant unit's code, or `''` for the
   * item's base pieces. Same meaning as voucher_transactions.stock_unit_code —
   * getting this wrong moves the wrong pool.
   */
  @Column({ name: 'stock_unit_code', type: 'text', default: '' })
  stockUnitCode!: string;

  /**
   * The item_units row the salesman picked, when they picked one.
   *
   * Kept because it is the only thing that lets the transfer move the SAME stock
   * pool the request was made against. Without it a request for a variant unit
   * would be received into the item's base pool — the goods would land on the
   * van under the wrong pool and the salesman's stock check would still fail.
   */
  @Column({ name: 'item_unit_id', type: 'uuid', nullable: true })
  itemUnitId?: string | null;

  /** Display unit snapshot ("كرتونة"). Null when the line is in base pieces. */
  @Column({ name: 'unit_name', type: 'text', nullable: true })
  unitName?: string | null;

  /** Pieces per unit: baseQty = qtyOfUnit × unitBaseQty. */
  @Column({ name: 'unit_base_qty', type: 'integer', default: 1 })
  unitBaseQty!: number;

  /** What the salesman asked for, in their chosen unit. */
  @Column({ name: 'qty_of_unit', type: 'numeric', precision: 14, scale: 3 })
  qtyOfUnit!: string;

  /** The same request in pool units — the figure the transfer moves. */
  @Column({ name: 'base_qty', type: 'numeric', precision: 14, scale: 3 })
  baseQty!: string;

  /**
   * What the manager actually granted, in pool units. Null while pending.
   * Zero is a real answer, and a different one from null: it means "reviewed and
   * refused this line" while the rest of the request went through.
   */
  @Column({ name: 'approved_base_qty', type: 'numeric', precision: 14, scale: 3, nullable: true })
  approvedBaseQty?: string | null;

  /** Van stock for this pool when the request was raised — context for the manager. */
  @Column({ name: 'van_qty_at_request', type: 'numeric', precision: 14, scale: 3, default: 0 })
  vanQtyAtRequest!: string;
}
